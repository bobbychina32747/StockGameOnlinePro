package game

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type contractCase struct {
	Principal Principal
	Raw       object
	Stocks    []any
	State     object
	Funds     []any
	Expected  object
}

func fixtures(t testing.TB) []contractCase {
	t.Helper()
	data, err := os.ReadFile("testdata/ledger.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []contractCase
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}
func newTestApp(t testing.TB, upstream, database string) *Server {
	t.Helper()
	app, err := New(Config{BackendURL: upstream, SiteOrigin: "https://game.bobbycn.cc", Database: database, Catalog: "../../../remaster/packages/domain/catalog.json", WebRoot: "../../../remaster/apps/web/dist", AllowedOrigins: []string{"http://fixture.test"}, StreamInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.Close(); err != nil {
			t.Error(err)
		}
	})
	return app
}
func TestSnapshotContract(t *testing.T) {
	app := newTestApp(t, "http://127.0.0.1:1", ":memory:")
	for _, fixture := range fixtures(t) {
		t.Run(fixture.Principal.Market, func(t *testing.T) {
			actual := app.ledger.adapt(fixture.Raw, fixture.Principal, fixture.Stocks, fixture.State, fixture.Funds)
			data, err := json.Marshal(actual)
			if err != nil {
				t.Fatal(err)
			}
			var normalized object
			json.Unmarshal(data, &normalized)
			if !reflect.DeepEqual(normalized, fixture.Expected) {
				assertObjects(t, "snapshot", fixture.Expected, normalized)
			}
			for _, other := range markets {
				if other != fixture.Principal.Market && obj(normalized["accounts"])[other] != nil {
					t.Fatal("private realm leaked")
				}
			}
		})
	}
}
func assertObjects(t *testing.T, path string, expected, actual any) {
	t.Helper()
	if reflect.DeepEqual(expected, actual) {
		return
	}
	left, leftOK := expected.(map[string]any)
	right, rightOK := actual.(map[string]any)
	if leftOK && rightOK {
		for key, value := range left {
			assertObjects(t, path+"."+key, value, right[key])
		}
		for key := range right {
			if _, ok := left[key]; !ok {
				t.Errorf("%s.%s unexpected: %v", path, key, right[key])
			}
		}
		return
	}
	if left, leftOK := expected.([]any); leftOK {
		if right, rightOK := actual.([]any); rightOK && len(left) == len(right) {
			for index := range left {
				assertObjects(t, fmt.Sprintf("%s[%d]", path, index), left[index], right[index])
			}
			return
		}
	}
	t.Errorf("%s: expected %v (%T), got %v (%T)", path, expected, expected, actual, actual)
}
func TestNodeSessionCompatibilityAndGoPersistence(t *testing.T) {
	data, err := os.ReadFile("testdata/node-session.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture object
	json.Unmarshal(data, &fixture)
	path := filepath.Join(t.TempDir(), "commands.sqlite")
	key, _ := base64.StdEncoding.DecodeString(str(fixture["key"]))
	os.WriteFile(path+".session-key", key, 0600)
	store, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	row := obj(fixture["row"])
	if _, err = store.db.Exec("INSERT INTO remembered_roles VALUES(?,?,?)", row["digest"], row["sealed"], row["expires"]); err != nil {
		t.Fatal(err)
	}
	session, err := store.loadSession(str(fixture["token"]))
	if err != nil || session == nil || session.GameToken != "synthetic-upstream-token" {
		t.Fatalf("Node session: %v, %v", session, err)
	}
	if err = store.saveSession("new-role", session); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	loaded, err := reopened.loadSession("new-role")
	if err != nil || loaded.Principal.Owner != session.Principal.Owner {
		t.Fatalf("Go restart: %v", err)
	}
	var sealed string
	reopened.db.QueryRow("SELECT sealed FROM remembered_roles WHERE digest=?", digest("new-role")).Scan(&sealed)
	if strings.Contains(sealed, "synthetic-upstream-token") {
		t.Fatal("plaintext credential stored")
	}
	if _, err = store.db.Exec("UPDATE remembered_roles SET sealed='corrupt' WHERE digest=?", digest("new-role")); err != nil {
		t.Fatal(err)
	}
	if loaded, err = reopened.loadSession("new-role"); err != nil || loaded != nil {
		t.Fatal("corrupt session accepted")
	}
}

type upstreamFixture struct {
	server                     *httptest.Server
	cases                      []contractCase
	mu                         sync.Mutex
	calls                      map[string]int
	order                      object
	siteToken                  string
	publicKey                  ed25519.PublicKey
	inactive, limited, unknown atomic.Bool
	version                    atomic.Int64
}

func newFixture(t testing.TB) *upstreamFixture {
	t.Helper()
	fixture := &upstreamFixture{cases: fixtures(t), calls: map[string]int{}}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fixture.publicKey = public
	header, _ := json.Marshal(object{"alg": "EdDSA", "kid": "test"})
	now := time.Now().Unix()
	claims, _ := json.Marshal(object{"iss": "https://bobbycn.cc", "aud": "bobbycn.cc", "sub": "identity-fixture", "sid": "session-fixture", "iat": now, "exp": now + 600})
	parts := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	fixture.siteToken = parts + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(parts)))
	fixture.server = httptest.NewServer(http.HandlerFunc(fixture.handle))
	t.Cleanup(fixture.server.Close)
	return fixture
}
func (fixture *upstreamFixture) count(path string) int {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return fixture.calls[path]
}
func (fixture *upstreamFixture) handle(w http.ResponseWriter, req *http.Request) {
	fixture.mu.Lock()
	fixture.calls[req.URL.Path]++
	fixture.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	var result any
	data := fixture.cases[0]
	switch req.URL.Path {
	case "/api/auth/login", "/api/auth/register":
		result = object{"token": "synthetic-upstream-token"}
	case "/api/auth/game-profile":
		if fixture.inactive.Load() {
			w.WriteHeader(401)
			result = object{"message": "disabled"}
		} else {
			result = object{"subject": "site:identity-fixture", "user": object{"id": "fixture", "username": "Synthetic", "isActive": true}}
		}
	case "/api/auth/site-session":
		result = object{"token": fixture.siteToken, "user": object{"id": "fixture", "username": "Synthetic"}}
	case "/api/auth/site-link":
		result = object{"success": true}
	case "/api/auth/identity/.well-known/jwks.json":
		result = object{"keys": []any{object{"kid": "test", "alg": "EdDSA", "kty": "OKP", "crv": "Ed25519", "x": base64.RawURLEncoding.EncodeToString(fixture.publicKey)}}}
	case "/api/auth/identity/introspect":
		if fixture.limited.Load() {
			w.WriteHeader(429)
			result = object{"message": "fixture throttle"}
		} else {
			result = object{"active": !fixture.inactive.Load(), "sub": "identity-fixture", "sid": "session-fixture"}
		}
	case "/api/market/stocks":
		result = data.Stocks
	case "/api/market/state":
		result = data.State
	case "/api/fund":
		result = data.Funds
	case "/api/account/unified":
		for _, item := range fixture.cases {
			if item.Principal.Market == req.URL.Query().Get("mode") {
				data = item
			}
		}
		encoded, _ := json.Marshal(data.Raw)
		var raw object
		json.Unmarshal(encoded, &raw)
		raw["ledgerVersion"] = fixture.version.Add(1)
		result = raw
	case "/api/market/klines":
		result = []any{object{"time": "2026-10-15T02:00:00Z", "open": 12, "close": 12.34, "high": 13, "low": 11, "volume": 100}}
	case "/api/market/orderbook":
		result = object{"bids": []any{object{"price": 12, "qty": 100}}, "asks": []any{object{"price": 12.5, "size": 200}}}
	case "/api/trading/order":
		fixture.mu.Lock()
		json.NewDecoder(req.Body).Decode(&fixture.order)
		fixture.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		if fixture.unknown.Load() {
			w.WriteHeader(503)
			result = object{"message": "lost response after write"}
		} else {
			result = object{"success": true, "order": list(data.Raw["orders"])[0]}
		}
	case "/api/trading/estimate":
		result = object{"valid": true, "price": 12, "fees": object{"totalFees": 5}}
	case "/api/account/leverage", "/api/account/reset", "/api/fund/fund-2/subscribe", "/api/season/enroll":
		result = object{"success": true}
	case "/api/market/backtest-v2":
		result = object{"strategy": "ma", "metrics": object{"totalReturn": .1}, "curve": []any{}, "trades": []any{}, "execution": "original fixture"}
	default:
		if req.Method == "DELETE" && strings.HasPrefix(req.URL.Path, "/api/trading/order/") {
			result = object{"success": true}
		} else {
			w.WriteHeader(404)
			result = object{"message": "unexpected fixture route"}
		}
	}
	json.NewEncoder(w).Encode(result)
}
func call(t testing.TB, client *http.Client, base, path, method, token string, body any, extra map[string]string) (int, object) {
	t.Helper()
	var encoded []byte
	if body != nil {
		encoded, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(method, base+"/api/v2/"+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range extra {
		req.Header.Set(key, value)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var value object
	if err = json.NewDecoder(res.Body).Decode(&value); err != nil {
		t.Fatalf("invalid response %s: %v", path, err)
	}
	return res.StatusCode, value
}
func login(t testing.TB, client *http.Client, base string, remember bool) string {
	status, value := call(t, client, base, "auth/login", "POST", "", object{"username": "fixture", "password": "synthetic-password", "market": "CN", "rememberMe": remember}, nil)
	if status != 200 {
		t.Fatalf("login: %d %v", status, value)
	}
	return str(value["token"])
}
func TestHTTPIdentityLedgerCommandsAndIsolation(t *testing.T) {
	fixture := newFixture(t)
	app := newTestApp(t, fixture.server.URL, ":memory:")
	server := httptest.NewServer(app)
	defer server.Close()
	client := server.Client()
	token := login(t, client, server.URL, false)
	status, state := call(t, client, server.URL, "state", "GET", token, nil, nil)
	if status != 200 {
		t.Fatal(status, state)
	}
	account := obj(obj(state["accounts"])["CN"])
	if num(account["cash"]) != 1234567 || account["id"] != "synthetic-account-CN" {
		t.Fatal(account)
	}
	_, site := call(t, client, server.URL, "auth/site-session", "POST", "", object{"market": "CN"}, nil)
	siteToken := str(site["token"])
	if site["owner"] != "game:fixture:CN" {
		t.Fatal(site)
	}
	for _, path := range []string{"history/" + str(obj(fixture.cases[0].Stocks[1])["symbol"]), "book/" + str(obj(fixture.cases[0].Stocks[1])["symbol"])} {
		status, _ = call(t, client, server.URL, path, "GET", token, nil, nil)
		if status != 400 {
			t.Fatal("cross-realm read", status)
		}
	}
	status, _ = call(t, client, server.URL, "commands", "POST", token, object{"kind": "leverage", "market": "US", "leverage": 2}, map[string]string{"Idempotency-Key": "wrong-realm"})
	if status != 400 {
		t.Fatal("cross-realm write", status)
	}
	symbol := str(obj(fixture.cases[0].Stocks[0])["symbol"])
	body := object{"kind": "order", "market": "CN", "input": object{"symbol": symbol, "side": "buy", "type": "limit", "quantity": 100, "price": 1199}}
	status, placed := call(t, client, server.URL, "commands", "POST", token, body, map[string]string{"Idempotency-Key": "same-order"})
	if status != 200 || placed["success"] != true {
		t.Fatal(status, placed)
	}
	status, repeated := call(t, client, server.URL, "commands", "POST", siteToken, body, map[string]string{"Idempotency-Key": "same-order"})
	if status != 200 || !reflect.DeepEqual(repeated, placed) || fixture.count("/api/trading/order") != 1 {
		t.Fatal("idempotency failure", status, repeated)
	}
	fixture.mu.Lock()
	order := fixture.order
	fixture.mu.Unlock()
	if num(order["price"]) != 11.99 || order["clientOrderId"] != digest("same-order") {
		t.Fatal(order)
	}
	status, _ = call(t, client, server.URL, "state", "GET", token, nil, nil)
	if status != 200 || fixture.count("/api/account/unified") != 2 {
		t.Fatal("snapshot not invalidated", status, fixture.count("/api/account/unified"))
	}
	status, estimate := call(t, client, server.URL, "orders/estimate", "POST", token, body, nil)
	if status != 200 || num(estimate["fee"]) != 500 || num(estimate["availableSell"]) != 200 {
		t.Fatal(status, estimate)
	}
	status, backtest := call(t, client, server.URL, "backtest", "POST", token, object{"symbol": symbol, "strategy": "ma"}, nil)
	if status != 200 || backtest["execution"] != "original fixture" {
		t.Fatal("backtest engine changed", status, backtest)
	}
	fixture.limited.Store(true)
	status, _ = call(t, client, server.URL, "state", "GET", siteToken, nil, nil)
	if status != 429 {
		t.Fatal("throttling lost", status)
	}
	fixture.limited.Store(false)
	status, _ = call(t, client, server.URL, "auth/logout", "POST", token, object{}, nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, _ = call(t, client, server.URL, "state", "GET", token, nil, nil)
	if status != 401 {
		t.Fatal("logout failed", status)
	}
	fixture.inactive.Store(true)
	status, _ = call(t, client, server.URL, "state", "GET", siteToken, nil, nil)
	if status != 401 {
		t.Fatal("disabled identity accepted", status)
	}
}
func TestConcurrentAndInterruptedCommands(t *testing.T) {
	fixture := newFixture(t)
	app := newTestApp(t, fixture.server.URL, ":memory:")
	token, _, err := app.auth.create(context.Background(), "synthetic-upstream-token", "CN", "game", false)
	if err != nil {
		t.Fatal(err)
	}
	session, err := app.auth.authenticate(context.Background(), token, "")
	if err != nil {
		t.Fatal(err)
	}
	body := object{"kind": "order", "market": "CN", "input": object{"symbol": obj(fixture.cases[0].Stocks[0])["symbol"], "side": "buy", "type": "limit", "quantity": float64(100), "price": float64(1199)}}
	var group sync.WaitGroup
	for index := 0; index < 12; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := app.ledger.command(context.Background(), session, body, "concurrent-key")
			var api *APIError
			if err != nil && (!errors.As(err, &api) || api.Status != 503) {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if fixture.count("/api/trading/order") != 1 {
		t.Fatal("duplicate settlement")
	}
	fixture.unknown.Store(true)
	if _, err = app.ledger.command(context.Background(), session, body, "interrupted-key"); err == nil {
		t.Fatal("uncertain write accepted")
	}
	if _, err = app.ledger.command(context.Background(), session, body, "interrupted-key"); err == nil {
		t.Fatal("uncertain write replayed")
	}
	if fixture.count("/api/trading/order") != 2 {
		t.Fatal("uncertain write retried")
	}
	changed := object{"kind": "reset", "market": "CN"}
	if _, err = app.ledger.command(context.Background(), session, changed, "concurrent-key"); err == nil {
		t.Fatal("key reused")
	}
}

func TestStreamUpdatesRevocationAndConnectionLimits(t *testing.T) {
	fixture := newFixture(t)
	app := newTestApp(t, fixture.server.URL, ":memory:")
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.StopStreams()
	token := login(t, server.Client(), server.URL, false)
	req, _ := http.NewRequest("GET", server.URL+"/api/v2/events?market=CN", nil)
	req.AddCookie(&http.Cookie{Name: "rgp-role-CN", Value: token})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := server.Client().Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatal(res.Status)
	}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	snapshots := 0
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "event: snapshot") {
			snapshots++
			if snapshots == 2 {
				break
			}
		}
	}
	if snapshots != 2 {
		t.Fatal("no live stream", scanner.Err())
	}
	if fixture.count("/api/account/unified") != 1 {
		t.Fatal("duplicate snapshot reads", fixture.count("/api/account/unified"))
	}
	fixture.inactive.Store(true)
	expired := false
	for scanner.Scan() {
		if scanner.Text() == "event: session-expired" {
			expired = true
			break
		}
	}
	if !expired {
		t.Fatal("revocation did not reach live stream", scanner.Err())
	}
	for index := 0; index < 5; index++ {
		if !app.reserveStream("test-owner") {
			t.Fatal("unexpected cap")
		}
	}
	if app.reserveStream("test-owner") {
		t.Fatal("connection cap bypassed")
	}
	for index := 0; index < 5; index++ {
		app.releaseStream("test-owner")
	}
}
func TestInputOriginsAndCookieSecurity(t *testing.T) {
	fixture := newFixture(t)
	app := newTestApp(t, fixture.server.URL, ":memory:")
	app.config.SecureCookies = true
	server := httptest.NewServer(app)
	defer server.Close()
	status, _ := call(t, server.Client(), server.URL, "auth/login", "POST", "", object{"market": "CN", "username": "fixture", "password": "synthetic"}, map[string]string{"Origin": "https://evil.invalid"})
	if status != 403 || fixture.count("/api/auth/login") != 0 {
		t.Fatal("origin accepted")
	}
	status, _ = call(t, server.Client(), server.URL, "auth/login", "POST", "", object{"market": "CN", "username": "fixture", "password": "synthetic", "rememberMe": "true"}, nil)
	if status != 400 {
		t.Fatal("invalid remember flag accepted")
	}
	req, _ := http.NewRequest("POST", server.URL+"/api/v2/auth/login", strings.NewReader(`{"username":"fixture","password":"synthetic","market":"CN","rememberMe":true}`))
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	cookies := res.Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].MaxAge != 604800 || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal(cookies)
	}
	for _, body := range []string{`[]`, `{} {}`, strings.Repeat("x", 65537)} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("POST", "/", strings.NewReader(body))
		if _, err := readBody(recorder, request); err == nil {
			t.Fatal("invalid JSON accepted")
		}
	}
	if _, err := orderInput(object{"input": object{"symbol": "X1", "side": "buy", "type": "limit", "quantity": 100.5, "price": 100.0}}); err == nil {
		t.Fatal("fractional shares accepted")
	}
}
func TestCacheMissesAndInvalidationDuringLoad(t *testing.T) {
	cache := newCache(2)
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		cache.get(context.Background(), "account", time.Hour, func() (any, error) { close(started); <-release; return "before-command", nil })
	}()
	<-started
	cache.invalidate("account")
	value, err := cache.get(context.Background(), "account", time.Hour, func() (any, error) { return "after-command", nil })
	if err != nil || value != "after-command" {
		t.Fatal(value, err)
	}
	close(release)
	<-done
	value, err = cache.get(context.Background(), "account", time.Hour, func() (any, error) { return nil, fmt.Errorf("unexpected reload") })
	if err != nil || value != "after-command" {
		t.Fatal("stale load replaced command result", value, err)
	}
}

func TestCommandJournalSurvivesRestartAndNodePropertyOrder(t *testing.T) {
	fixture := newFixture(t)
	database := filepath.Join(t.TempDir(), "commands.sqlite")
	app := newTestApp(t, fixture.server.URL, database)
	token, _, err := app.auth.create(context.Background(), "synthetic-upstream-token", "CN", "game", true)
	if err != nil {
		t.Fatal(err)
	}
	session, err := app.auth.authenticate(context.Background(), token, "")
	if err != nil {
		t.Fatal(err)
	}
	// A row written by Node keeps its property insertion order. Go canonicalizes it for comparison.
	body := `{"market":"CN","amount":10000,"action":"buy","fund":"money","kind":"fund"}`
	_, err = app.store.db.Exec("INSERT INTO formal_commands VALUES(?,?,?,'complete',?)", session.Principal.Owner, "node-written-key", body, `{"success":true,"version":42}`)
	if err != nil {
		t.Fatal(err)
	}
	reopened := newTestApp(t, fixture.server.URL, database)
	recovered, err := reopened.auth.authenticate(context.Background(), token, "")
	if err != nil {
		t.Fatal(err)
	}
	var command object
	json.Unmarshal([]byte(body), &command)
	value, err := reopened.ledger.command(context.Background(), recovered, command, "node-written-key")
	if err != nil || num(obj(value)["version"]) != 42 || fixture.count("/api/fund/fund-2/subscribe") != 0 {
		t.Fatal("completed command replayed after restart", value, err)
	}
	_, err = app.store.db.Exec("INSERT INTO formal_commands VALUES(?,?,?,'pending',NULL)", session.Principal.Owner, "pending-after-restart", body)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reopened.ledger.command(context.Background(), recovered, command, "pending-after-restart"); err == nil {
		t.Fatal("pending command replayed after restart")
	}
	if fixture.count("/api/fund/fund-2/subscribe") != 0 {
		t.Fatal("duplicate financial write")
	}
	// Browser JSON property order must survive Go writes so rollback to Node can replay it.
	json.Unmarshal([]byte(body), &command)
	if _, err = reopened.ledger.command(context.Background(), recovered, command, "go-written-key", body); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err = reopened.store.db.QueryRow("SELECT body FROM formal_commands WHERE owner=? AND key=?", session.Principal.Owner, "go-written-key").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != body {
		t.Fatal("Go changed browser command order; Node rollback would reject the replay")
	}
}

func TestShutdownRejectsNewStreamReservations(t *testing.T) {
	app := newTestApp(t, "http://127.0.0.1:1", ":memory:")
	app.StopStreams()
	if app.reserveStream("fixture-owner") {
		app.releaseStream("fixture-owner")
		t.Fatal("stream accepted during shutdown")
	}
}

func TestSiteRejectsTamperedSignatureAndMalformedClaims(t *testing.T) {
	fixture := newFixture(t)
	app := newTestApp(t, fixture.server.URL, ":memory:")
	_, claims, parts, err := splitJWT(fixture.siteToken)
	if err != nil {
		t.Fatal(err)
	}
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	signature[0] ^= 1
	tampered := parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString(signature)
	if _, err = app.auth.verifySite(context.Background(), tampered); err == nil {
		t.Fatal("forged signature accepted")
	}
	claims["exp"] = numberString(claims["exp"])
	encoded, _ := json.Marshal(claims)
	malformed := parts[0] + "." + base64.RawURLEncoding.EncodeToString(encoded) + "." + parts[2]
	if _, err = app.auth.verifySite(context.Background(), malformed); err == nil {
		t.Fatal("string expiry accepted")
	}
	if fixture.count("/api/auth/identity/introspect") != 0 {
		t.Fatal("unverified identity reached introspection")
	}
}

func BenchmarkSnapshotRealm138(b *testing.B) {
	fixture := fixtures(b)[0]
	app := newTestApp(b, "http://127.0.0.1:1", ":memory:")
	b.ReportAllocs()
	b.ResetTimer()
	stocks := []any{}
	for _, instrument := range app.ledger.catalog {
		row := object{}
		for key, value := range obj(fixture.Stocks[0]) {
			row[key] = value
		}
		row["symbol"] = instrument["symbol"]
		row["market"] = instrument["market"]
		stocks = append(stocks, row)
	}
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if _, err := json.Marshal(app.ledger.adapt(fixture.Raw, fixture.Principal, stocks, fixture.State, fixture.Funds)); err != nil {
			b.Fatal(err)
		}
	}
}
