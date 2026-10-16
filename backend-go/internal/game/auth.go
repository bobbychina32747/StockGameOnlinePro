package game

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"
)

var markets = []string{"CN", "HK", "US"}

func validMarket(market string) bool { return market == "CN" || market == "HK" || market == "US" }

type Principal struct {
	Owner      string `json:"owner"`
	Name       string `json:"name"`
	Market     string `json:"market"`
	Mode       string `json:"mode"`
	RememberMe bool   `json:"rememberMe,omitempty"`
	Token      string `json:"token,omitempty"`
}
type Session struct {
	Principal Principal `json:"principal"`
	GameToken string    `json:"gameToken,omitempty"`
	SiteToken string    `json:"siteToken,omitempty"`
	Expires   int64     `json:"expires"`
	mu        sync.Mutex
}
type Auth struct {
	mu           sync.Mutex
	sessions     map[string]*Session
	store        *Store
	up           *Upstream
	checks, keys *Cache
}

func newAuth(store *Store, up *Upstream) *Auth {
	return &Auth{sessions: map[string]*Session{}, store: store, up: up, checks: newCache(1), keys: newCache(1)}
}
func (auth *Auth) get(token string) (*Session, error) {
	if len(token) == 0 || len(token) > 8192 {
		return nil, errorf(401, "请先登录")
	}
	auth.mu.Lock()
	defer auth.mu.Unlock()
	if session := auth.sessions[token]; session != nil {
		return session, nil
	}
	session, err := auth.store.loadSession(token)
	if err != nil {
		return nil, errorf(503, "无法读取角色会话")
	}
	if session == nil {
		return nil, errorf(401, "请重新选择区服角色登录")
	}
	if err = auth.retain(token, session); err != nil {
		return nil, err
	}
	return session, nil
}

// retain is called with auth.mu held. Only remembered sessions can be evicted safely.
func (auth *Auth) retain(token string, session *Session) error {
	if len(auth.sessions) >= 4096 {
		for key, entry := range auth.sessions {
			if entry.Expires <= time.Now().UnixMilli() || entry.Principal.RememberMe {
				delete(auth.sessions, key)
				break
			}
		}
		if len(auth.sessions) >= 4096 {
			return errorf(503, "角色会话已达容量，请稍后重试")
		}
	}
	auth.sessions[token] = session
	return nil
}
func (auth *Auth) authenticate(ctx context.Context, token, cookie string) (*Session, error) {
	result, err := auth.checks.get(ctx, digest(token), 0, func() (any, error) { return auth.check(ctx, token, cookie) })
	if err != nil {
		return nil, err
	}
	return result.(*Session), nil
}
func (auth *Auth) check(ctx context.Context, token, cookie string) (*Session, error) {
	session, err := auth.get(token)
	if err != nil {
		return nil, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.Expires <= time.Now().UnixMilli() {
		auth.revoke(token)
		return nil, errorf(401, "角色会话已过期")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if session.Principal.Mode == "game" {
		profile, err := auth.up.call(ctx, "GET", "/api/auth/game-profile", session.GameToken, "", "", nil)
		if err != nil {
			return nil, err
		}
		user := obj(obj(profile)["user"])
		if truth(user["isActive"]) == false && user["isActive"] != nil || "game:"+str(user["id"])+":"+session.Principal.Market != session.Principal.Owner {
			auth.revoke(token)
			return nil, errorf(401, "账号绑定已变化，请重新登录")
		}
		return session, nil
	}
	if session.Principal.Mode != "site" {
		return nil, errorf(401, "角色会话无效")
	}
	_, claims, _, err := splitJWT(session.SiteToken)
	if err != nil {
		return nil, errorf(401, "站点会话无效")
	}
	if num(claims["exp"]) <= float64(time.Now().Unix()+60) && cookie != "" {
		if err = auth.refreshSite(ctx, session, claims, cookie); err != nil {
			return nil, err
		}
		if session.Principal.RememberMe {
			if err = auth.store.saveSession(token, session); err != nil {
				return nil, errorf(503, "无法保存角色会话")
			}
		}
	}
	if _, err = auth.verifySite(ctx, session.SiteToken); err != nil {
		return nil, err
	}
	return session, nil
}
func (auth *Auth) refreshSite(ctx context.Context, session *Session, old object, cookie string) error {
	linked, err := auth.up.call(ctx, "POST", "/api/auth/site-session", "", cookie, "", object{"create": false})
	if err != nil {
		return err
	}
	current := obj(linked)
	claims, err := auth.verifySite(ctx, str(current["token"]))
	if err != nil {
		return err
	}
	owner := "game:" + str(obj(current["user"])["id"]) + ":" + session.Principal.Market
	if claims["sub"] != old["sub"] || claims["sid"] != old["sid"] || owner != session.Principal.Owner {
		return errorf(401, "站点账号已变化，请重新登录")
	}
	session.SiteToken = str(current["token"])
	return nil
}

var jwtPart = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func splitJWT(token string) (object, object, []string, error) {
	parts := make([]string, 0, 3)
	start := 0
	for index := 0; index <= len(token); index++ {
		if index == len(token) || token[index] == '.' {
			parts = append(parts, token[start:index])
			start = index + 1
		}
	}
	if len(parts) != 3 {
		return nil, nil, nil, errorf(401, "站点令牌无效")
	}
	decoded := make([]object, 2)
	for index, part := range parts {
		if !jwtPart.MatchString(part) {
			return nil, nil, nil, errorf(401, "站点令牌无效")
		}
		if index > 1 {
			continue
		}
		bytes, err := base64.RawURLEncoding.DecodeString(part)
		if err != nil {
			return nil, nil, nil, err
		}
		if err = json.Unmarshal(bytes, &decoded[index]); err != nil {
			return nil, nil, nil, err
		}
	}
	return decoded[0], decoded[1], parts, nil
}
func (auth *Auth) verifySite(ctx context.Context, token string) (object, error) {
	header, claims, parts, err := splitJWT(token)
	if err != nil {
		return nil, errorf(401, "站点会话已失效")
	}
	now := float64(time.Now().Unix())
	exp := num(claims["exp"])
	issued := num(claims["iat"])
	_, validExpiryType := claims["exp"].(float64)
	_, validIssuedType := claims["iat"].(float64)
	if header["alg"] != "EdDSA" || claims["iss"] != "https://bobbycn.cc" || claims["aud"] != "bobbycn.cc" ||
		str(claims["sub"]) == "" || str(claims["sid"]) == "" || claims["client_id"] != nil || !validExpiryType || !validIssuedType || exp != float64(int64(exp)) || issued != float64(int64(issued)) || exp <= now || issued > now+60 || exp-issued > 600 {
		return nil, errorf(401, "站点会话已失效")
	}
	if err = auth.verifySignature(ctx, token, header, parts); err != nil {
		return nil, err
	}
	active, err := auth.up.call(ctx, "POST", "/api/auth/identity/introspect", "", "", "", object{"token": token})
	if err != nil {
		return nil, authError(err)
	}
	record := obj(active)
	if record["active"] != true || record["sub"] != claims["sub"] || record["sid"] != claims["sid"] {
		return nil, errorf(401, "站点会话已失效")
	}
	return claims, nil
}
func authError(err error) error {
	var api *APIError
	if errors.As(err, &api) && (api.Status == 429 || api.Status >= 500) {
		return err
	}
	return errorf(401, "站点会话已失效")
}
func (auth *Auth) verifySignature(ctx context.Context, token string, header object, parts []string) error {
	for attempt := 0; attempt < 2; attempt++ {
		keys, err := auth.keys.get(ctx, "jwks", 10*time.Minute, func() (any, error) {
			return auth.up.call(ctx, "GET", "/api/auth/identity/.well-known/jwks.json", "", "", "", nil)
		})
		if err != nil {
			return authError(err)
		}
		for _, item := range list(obj(keys)["keys"]) {
			key := obj(item)
			if key["kid"] != header["kid"] || key["kty"] != "OKP" || key["crv"] != "Ed25519" || key["alg"] != "EdDSA" {
				continue
			}
			public, err := base64.RawURLEncoding.DecodeString(str(key["x"]))
			signature, sigErr := base64.RawURLEncoding.DecodeString(parts[2])
			if err != nil || sigErr != nil || len(public) != ed25519.PublicKeySize || !ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), signature) {
				return errorf(401, "站点会话已失效")
			}
			return nil
		}
		auth.keys.invalidate("jwks")
	}
	return errorf(401, "站点签名密钥无效")
}
func (auth *Auth) create(ctx context.Context, backendToken, market, mode string, remember bool) (string, Principal, error) {
	if !validMarket(market) || backendToken == "" || len(backendToken) > 8192 {
		return "", Principal{}, errorf(400, "请选择有效区服")
	}
	profile, err := auth.up.call(ctx, "GET", "/api/auth/game-profile", backendToken, "", "", nil)
	if err != nil {
		return "", Principal{}, err
	}
	user := obj(obj(profile)["user"])
	subject := str(obj(profile)["subject"])
	if !regexp.MustCompile(`^(game|site):[A-Za-z0-9_-]{1,128}$`).MatchString(subject) || str(user["id"]) == "" || str(user["username"]) == "" || user["isActive"] == false {
		return "", Principal{}, errorf(401, "游戏账号不可用")
	}
	if mode == "site" {
		claims, err := auth.verifySite(ctx, backendToken)
		if err != nil {
			return "", Principal{}, err
		}
		if subject != "site:"+str(claims["sub"]) {
			return "", Principal{}, errorf(401, "站点账号绑定不一致")
		}
	}
	principal := Principal{Owner: "game:" + str(user["id"]) + ":" + market, Name: str(user["username"]), Market: market, Mode: mode, RememberMe: remember}
	ttl := 24 * time.Hour
	if remember {
		ttl = 7 * 24 * time.Hour
	}
	session := &Session{Principal: principal, Expires: time.Now().Add(ttl).UnixMilli()}
	if mode == "game" {
		session.GameToken = backendToken
	} else {
		session.SiteToken = backendToken
	}
	random := make([]byte, 32)
	if _, err = rand.Read(random); err != nil {
		return "", Principal{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(random)
	if remember {
		if err = auth.store.saveSession(token, session); err != nil {
			return "", Principal{}, err
		}
	}
	auth.mu.Lock()
	err = auth.retain(token, session)
	auth.mu.Unlock()
	return token, principal, err
}
func (auth *Auth) revoke(token string) error {
	auth.mu.Lock()
	delete(auth.sessions, token)
	auth.mu.Unlock()
	return auth.store.removeSession(token)
}
func (session *Session) backendToken() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.GameToken != "" {
		return session.GameToken
	}
	return session.SiteToken
}
func tokenFrom(req *http.Request) string {
	if bearer := req.Header.Get("Authorization"); len(bearer) > 7 && bearer[:7] == "Bearer " {
		return bearer[7:]
	}
	market := req.Header.Get("X-Game-Realm")
	if req.URL.Path == "/api/v2/events" {
		market = req.URL.Query().Get("market")
	}
	if !validMarket(market) {
		market = "CN"
	}
	for _, name := range []string{"rgp-role-" + market, "rgp-demo"} {
		if cookie, err := req.Cookie(name); err == nil {
			return cookie.Value
		}
	}
	return ""
}
