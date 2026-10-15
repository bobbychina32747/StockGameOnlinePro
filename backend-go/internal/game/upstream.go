package game

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Upstream struct {
	base   *url.URL
	origin string
	client *http.Client
}

func NewUpstream(base, origin string) (*Upstream, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errorf(500, "Invalid backend URL")
	}
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, MaxConnsPerHost: 16, MaxIdleConnsPerHost: 16,
		IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 15 * time.Second}
	return &Upstream{base: parsed, origin: origin, client: &http.Client{Transport: transport, Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (up *Upstream) call(ctx context.Context, method, path, token, cookie, ip string, body any) (any, error) {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, errorf(400, "请求数据无效")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, up.base.ResolveReference(&url.URL{Path: "/"}).String(), bytes.NewReader(payload))
	if err != nil {
		return nil, errorf(503, "无法连接账本服务")
	}
	// Paths are assembled exclusively from fixed route prefixes and escaped query values.
	target, err := url.Parse(path)
	if err != nil || target.IsAbs() || target.Host != "" || len(path) == 0 || path[0] != '/' {
		return nil, errorf(400, "接口路径无效")
	}
	req.URL = up.base.ResolveReference(target)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", up.origin)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	res, err := up.client.Do(req)
	if err != nil {
		return nil, errorf(503, "账本服务暂不可用，请核对原操作结果后重试")
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024+1))
	if err != nil || len(data) > 8*1024*1024 {
		return nil, errorf(503, "账本响应超过限制或读取失败")
	}
	var result any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, errorf(503, "账本响应格式无效")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message := str(obj(result)["message"])
		if message == "" {
			message = "账本服务拒绝了请求"
		}
		return nil, errorf(res.StatusCode, "%s", message)
	}
	return result, nil
}

type cacheEntry struct {
	data    any
	expires time.Time
}
type flight struct {
	done        chan struct{}
	data        any
	err         error
	invalidated bool
}

// Cache bounds retained entries and merges concurrent misses. Failures are never cached.
type Cache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	flights map[string]*flight
	limit   int
}

func newCache(limit int) *Cache {
	return &Cache{entries: map[string]cacheEntry{}, flights: map[string]*flight{}, limit: limit}
}
func (cache *Cache) get(ctx context.Context, key string, ttl time.Duration, load func() (any, error)) (any, error) {
	cache.mu.Lock()
	if entry, ok := cache.entries[key]; ok && time.Now().Before(entry.expires) {
		cache.mu.Unlock()
		return entry.data, nil
	}
	if active, ok := cache.flights[key]; ok {
		cache.mu.Unlock()
		select {
		case <-active.done:
			return active.data, active.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	active := &flight{done: make(chan struct{})}
	cache.flights[key] = active
	cache.mu.Unlock()
	active.data, active.err = load()
	cache.mu.Lock()
	if cache.flights[key] == active {
		delete(cache.flights, key)
	}
	if active.err == nil && !active.invalidated {
		if len(cache.entries) >= cache.limit {
			for old := range cache.entries {
				delete(cache.entries, old)
				break
			}
		}
		cache.entries[key] = cacheEntry{data: active.data, expires: time.Now().Add(ttl)}
	}
	close(active.done)
	cache.mu.Unlock()
	return active.data, active.err
}
func (cache *Cache) invalidate(key string) {
	cache.mu.Lock()
	delete(cache.entries, key)
	if active := cache.flights[key]; active != nil {
		active.invalidated = true
		delete(cache.flights, key)
	}
	cache.mu.Unlock()
}
