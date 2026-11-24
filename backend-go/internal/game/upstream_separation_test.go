package game

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestSiteIdentityAndLedgerUseDistinctUpstreams(t *testing.T) {
	var siteCalls, ledgerCalls atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		siteCalls.Add(1)
		if r.URL.Path != "/api/auth/identity/introspect" {
			t.Errorf("Unexpected site route %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"active":true}`))
	}))
	defer site.Close()
	ledger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ledgerCalls.Add(1)
		if r.URL.Path != "/api/market/state" {
			t.Errorf("Identity request reached ledger: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tick":1}`))
	}))
	defer ledger.Close()
	up, err := NewUpstream(ledger.URL, "https://game.bobbycn.cc")
	if err != nil {
		t.Fatal(err)
	}
	defer up.client.CloseIdleConnections()
	if err = up.setSiteIdentity(site.URL); err != nil {
		t.Fatal(err)
	}
	if _, err = up.call(context.Background(), "POST", "/api/auth/identity/introspect", "", "", "", object{"token": "synthetic"}); err != nil {
		t.Fatal(err)
	}
	if _, err = up.call(context.Background(), "GET", "/api/market/state", "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	if siteCalls.Load() != 1 || ledgerCalls.Load() != 1 {
		t.Fatal("Requests crossed service boundaries")
	}
	up.setSiteIdentity("")
	if _, err = up.call(context.Background(), "POST", "/api/auth/identity/introspect", "", "", "", object{}); err == nil {
		t.Fatal("Unconfigured site service must fail closed")
	}
	if _, err = up.call(context.Background(), "GET", "/api/auth/identity/unsupported", "", "", "", nil); err == nil {
		t.Fatal("Unknown identity route must not reach ledger")
	}
	if siteCalls.Load() != 1 || ledgerCalls.Load() != 1 {
		t.Fatal("Missing configuration fell back to ledger")
	}
}
