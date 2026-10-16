package game

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Config struct {
	BackendURL, SiteOrigin, Database, Catalog, WebRoot string
	AllowedOrigins                                     []string
	SecureCookies, TrustProxy                          bool
	MaxStreams                                         int
	StreamInterval                                     time.Duration
}
type Server struct {
	config      Config
	auth        *Auth
	ledger      *Ledger
	store       *Store
	up          *Upstream
	ctx         context.Context
	cancel      context.CancelFunc
	slots       chan struct{}
	streamMu    sync.Mutex
	streams     map[string]int
	streamCount int
	streamWait  sync.WaitGroup
}

func New(config Config) (*Server, error) {
	if config.StreamInterval == 0 {
		config.StreamInterval = 2 * time.Second
	}
	if config.MaxStreams == 0 {
		config.MaxStreams = 128
	}
	if config.StreamInterval < 100*time.Millisecond || config.MaxStreams < 1 {
		return nil, errors.New("invalid streaming limits")
	}
	up, err := NewUpstream(config.BackendURL, config.SiteOrigin)
	if err != nil {
		return nil, err
	}
	store, err := openStore(config.Database)
	if err != nil {
		return nil, err
	}
	ledger, err := newLedger(up, store, config.Catalog)
	if err != nil {
		store.db.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := &Server{config: config, auth: newAuth(store, up), ledger: ledger, store: store, up: up, ctx: ctx, cancel: cancel, slots: make(chan struct{}, 64), streams: map[string]int{}}
	go server.maintenance()
	return server, nil
}
func (server *Server) StopStreams() {
	server.streamMu.Lock()
	server.cancel()
	server.streamMu.Unlock()
}
func (server *Server) Close() error {
	server.StopStreams()
	server.streamWait.Wait()
	server.up.client.CloseIdleConnections()
	return server.store.db.Close()
}
func (server *Server) maintenance() {
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-server.ctx.Done():
			return
		case <-timer.C:
			server.auth.mu.Lock()
			for token, entry := range server.auth.sessions {
				if entry.Expires <= time.Now().UnixMilli() {
					delete(server.auth.sessions, token)
				}
			}
			server.auth.mu.Unlock()
			if _, err := server.store.db.Exec("DELETE FROM remembered_roles WHERE expires<=?", time.Now().UnixMilli()); err != nil {
				slog.Warn("expired session cleanup failed")
			}
		}
	}
}
func (server *Server) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	origin := req.Header.Get("Origin")
	allowed := origin == "" || member(origin, server.config.AllowedOrigins...)
	if origin != "" && allowed {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Vary", "Origin")
	}
	if req.Method == "OPTIONS" {
		if !allowed {
			writeError(w, errorf(403, "请求来源不受信任"))
			return
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key,X-Game-Realm")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.WriteHeader(204)
		return
	}
	if req.Method != "GET" && !allowed {
		writeError(w, errorf(403, "请求来源不受信任"))
		return
	}
	if !strings.HasPrefix(req.URL.Path, "/api/") {
		server.static(w, req)
		return
	}
	if req.Method != "GET" && req.Method != "POST" {
		writeError(w, errorf(405, "请求方法无效"))
		return
	}
	select {
	case server.slots <- struct{}{}:
	default:
		writeError(w, errorf(503, "请求过多，请稍后重试"))
		return
	}
	if req.URL.Path == "/api/v2/events" && req.Method == "GET" {
		<-server.slots
		if !allowed {
			writeError(w, errorf(403, "请求来源不受信任"))
			return
		}
		server.stream(w, req)
		return
	}
	defer func() {
		<-server.slots
		if recovered := recover(); recovered != nil {
			slog.Error("request failed", "path", req.URL.Path)
			writeError(w, errorf(500, "服务处理失败"))
		}
	}()
	ctx, cancel := context.WithTimeout(req.Context(), 20*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	value, err := server.route(w, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, value)
}
func (server *Server) route(w http.ResponseWriter, req *http.Request) (any, error) {
	path := strings.TrimPrefix(req.URL.Path, "/api/v2/")
	if req.Method == "GET" && path == "config" {
		return object{"protocolVersion": 2, "sandbox": false, "unified": true, "mode": "real", "version": "2.1.0-go", "siteLogin": "https://bobbycn.cc/login/", "transport": "sse", "runtime": "go", "migrationPhase": "api"}, nil
	}
	if req.Method == "GET" && path == "health" {
		return server.health(req.Context())
	}
	if strings.HasPrefix(path, "auth/") {
		return server.authRoute(w, req, strings.TrimPrefix(path, "auth/"))
	}
	session, err := server.auth.authenticate(req.Context(), tokenFrom(req), req.Header.Get("Cookie"))
	if err != nil {
		return nil, err
	}
	if req.Method == "GET" {
		return server.readRoute(req, session, path)
	}
	body, raw, err := readBodyJSON(w, req)
	if err != nil {
		return nil, err
	}
	switch path {
	case "commands":
		return server.ledger.command(req.Context(), session, body, req.Header.Get("Idempotency-Key"), string(raw))
	case "orders/estimate":
		return server.ledger.estimate(req.Context(), session, body)
	case "backtest":
		return server.backtest(req.Context(), session, body)
	}
	return nil, errorf(404, "接口不存在")
}
func readBody(w http.ResponseWriter, req *http.Request) (object, error) {
	value, _, err := readBodyJSON(w, req)
	return value, err
}
func readBodyJSON(w http.ResponseWriter, req *http.Request) (object, []byte, error) {
	reader := http.MaxBytesReader(w, req.Body, 64*1024)
	defer reader.Close()
	raw, err := io.ReadAll(reader)
	if err != nil {
		return nil, nil, errorf(400, "请求超过64KB或读取失败")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var value object
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, nil, errorf(400, "请求必须是有效 JSON 对象（最多64KB）")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, nil, errorf(400, "请求只能包含一个 JSON 对象")
	}
	return value, raw, nil
}
func writeError(w http.ResponseWriter, err error) {
	status, message := 503, "服务暂不可用"
	var api *APIError
	if errors.As(err, &api) {
		status = api.Status
		message = api.Message
	}
	if status < 400 || status > 599 {
		status = 503
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(object{"statusCode": status, "message": message})
}
func writeJSON(w http.ResponseWriter, value any) {
	data, ok := value.([]byte)
	if !ok {
		var err error
		data, err = json.Marshal(value)
		if err != nil {
			writeError(w, errorf(503, "响应格式无效"))
			return
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(data)
}
func (server *Server) static(w http.ResponseWriter, req *http.Request) {
	if req.Method != "GET" && req.Method != "HEAD" {
		writeError(w, errorf(405, "请求方法无效"))
		return
	}
	if req.URL.Path == "/" || req.URL.Path == "/login" || req.URL.Path == "/login/" {
		http.ServeFile(w, req, filepath.Join(server.config.WebRoot, "index.html"))
		return
	}
	http.FileServer(http.Dir(server.config.WebRoot)).ServeHTTP(w, req)
}
func (server *Server) health(ctx context.Context) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	state, err := server.ledger.public.get(ctx, "health", time.Second, func() (any, error) { return server.up.call(ctx, "GET", "/api/market/state", "", "", "", nil) })
	if err != nil {
		return nil, err
	}
	return object{"healthy": true, "mode": "real", "ledger": "legacy-authoritative", "runtime": "go", "migrationPhase": "api", "tickHealth": obj(state)["tickHealth"]}, nil
}
func (server *Server) authRoute(w http.ResponseWriter, req *http.Request, path string) (any, error) {
	if req.Method == "GET" && path == "session" {
		session, err := server.auth.authenticate(req.Context(), tokenFrom(req), req.Header.Get("Cookie"))
		if err != nil {
			return nil, err
		}
		return session.Principal, nil
	}
	if req.Method != "POST" {
		return nil, errorf(405, "请求方法无效")
	}
	if path == "logout" {
		market := req.Header.Get("X-Game-Realm")
		if !validMarket(market) {
			market = "CN"
		}
		token := tokenFrom(req)
		if session, err := server.auth.get(token); err == nil {
			market = session.Principal.Market
		}
		if err := server.auth.revoke(token); err != nil {
			return nil, errorf(503, "退出未完成，请重试")
		}
		server.cookie(w, "", market, false, -1)
		return object{"success": true}, nil
	}
	body, err := readBody(w, req)
	if err != nil {
		return nil, err
	}
	if path == "site-link" {
		if !validCredentials(body, false) {
			return nil, errorf(400, "请输入有效账密")
		}
		_, err = server.up.call(req.Context(), "POST", "/api/auth/site-link", "", req.Header.Get("Cookie"), "", object{"username": body["username"], "password": body["password"]})
		return object{"success": true}, err
	}
	market := str(body["market"])
	if !validMarket(market) {
		return nil, errorf(400, "请选择有效区服")
	}
	if body["rememberMe"] != nil {
		if _, ok := body["rememberMe"].(bool); !ok {
			return nil, errorf(400, "记住我选项无效")
		}
	}
	remember := truth(body["rememberMe"])
	mode := "game"
	var result any
	switch path {
	case "login", "register":
		if !validCredentials(body, path == "register") {
			return nil, errorf(400, "请输入有效账密；注册密码至少8位且不超过72个UTF-8字节")
		}
		result, err = server.up.call(req.Context(), "POST", "/api/auth/"+path, "", "", server.clientIP(req), object{"username": strings.TrimSpace(str(body["username"])), "password": body["password"], "rememberMe": remember})
	case "site-session":
		mode = "site"
		result, err = server.up.call(req.Context(), "POST", "/api/auth/site-session", "", req.Header.Get("Cookie"), "", object{"create": truth(body["create"])})
	default:
		return nil, errorf(404, "接口不存在")
	}
	if err != nil {
		return nil, err
	}
	row := obj(result)
	if truth(row["needsAccountSetup"]) {
		return object{"needsAccountSetup": true, "identity": row["identity"]}, nil
	}
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	token, principal, err := server.auth.create(ctx, str(row["token"]), market, mode, remember)
	if err != nil {
		return nil, err
	}
	server.cookie(w, token, market, remember, 0)
	principal.Token = token
	return principal, nil
}
func validCredentials(body object, register bool) bool {
	name, password := str(body["username"]), str(body["password"])
	length := utf8.RuneCountInString(password)
	if utf8.RuneCountInString(strings.TrimSpace(name)) < 2 || utf8.RuneCountInString(name) > 50 || length < 1 || length > 200 {
		return false
	}
	return !register || (length >= 8 && len(password) <= 72)
}
func (server *Server) cookie(w http.ResponseWriter, token, market string, remember bool, maxAge int) {
	if remember {
		maxAge = 604800
	}
	http.SetCookie(w, &http.Cookie{Name: "rgp-role-" + market, Value: token, Path: "/", HttpOnly: true, Secure: server.config.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func (server *Server) clientIP(req *http.Request) string {
	remote, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		remote = req.RemoteAddr
	}
	if server.config.TrustProxy {
		parts := strings.Split(req.Header.Get("X-Forwarded-For"), ",")
		candidate := strings.TrimSpace(parts[len(parts)-1])
		if net.ParseIP(candidate) != nil {
			return candidate
		}
	}
	return remote
}

// ConfigFromEnv preserves the formal adapter's existing deployment variable names.
func ConfigFromEnv() Config {
	get := func(key, fallback string) string {
		if value := os.Getenv(key); value != "" {
			return value
		}
		return fallback
	}
	return Config{BackendURL: get("REMASTER_IDENTITY_URL", "http://127.0.0.1:8000"), SiteOrigin: get("REMASTER_SITE_ORIGIN", "https://game.bobbycn.cc"), Database: get("UNIFIED_COMMAND_DB", "data/formal-commands.sqlite"), Catalog: get("SGP_CATALOG", "../remaster/packages/domain/catalog.json"), WebRoot: get("SGP_WEB_ROOT", "../remaster/apps/web/dist"), AllowedOrigins: strings.Split(get("REMASTER_ALLOWED_ORIGINS", "http://127.0.0.1:8321,http://localhost:8321"), ","), SecureCookies: get("REMASTER_COOKIE_SECURE", "") == "true", TrustProxy: get("REMASTER_TRUST_PROXY", "") == "1"}
}
