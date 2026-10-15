package game

import (
	"errors"
	"fmt"
	"net/http"
	"time"
)

func (server *Server) reserveStream(owner string) bool {
	server.streamMu.Lock()
	defer server.streamMu.Unlock()
	if server.ctx.Err() != nil || server.streamCount >= server.config.MaxStreams || server.streams[owner] >= 5 {
		return false
	}
	server.streams[owner]++
	server.streamCount++
	server.streamWait.Add(1)
	return true
}
func (server *Server) releaseStream(owner string) {
	server.streamMu.Lock()
	server.streams[owner]--
	server.streamCount--
	if server.streams[owner] == 0 {
		delete(server.streams, owner)
	}
	server.streamMu.Unlock()
	server.streamWait.Done()
}
func sendEvent(w http.ResponseWriter, event string, data []byte) error {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); err != nil {
		return err
	}
	return controller.Flush()
}
func (server *Server) stream(w http.ResponseWriter, req *http.Request) {
	token, cookie := tokenFrom(req), req.Header.Get("Cookie")
	session, err := server.auth.authenticate(req.Context(), token, cookie)
	if err != nil {
		writeError(w, err)
		return
	}
	owner := session.Principal.Owner
	if !server.reserveStream(owner) {
		writeError(w, errorf(429, "行情连接数达到上限，请关闭多余标签页"))
		return
	}
	defer server.releaseStream(owner)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	timer := time.NewTicker(server.config.StreamInterval)
	defer timer.Stop()
	for {
		session, err = server.auth.authenticate(req.Context(), token, cookie)
		if err == nil {
			var data []byte
			data, err = server.ledger.snapshot(req.Context(), session)
			if err == nil {
				if err = sendEvent(w, "snapshot", data); err != nil {
					return
				}
			}
		}
		if err != nil {
			var api *APIError
			if errors.As(err, &api) && api.Status == 401 {
				sendEvent(w, "session-expired", []byte(`{}`))
				return
			}
			if err = sendEvent(w, "backend-unavailable", []byte(`{"message":"行情暂不可用"}`)); err != nil {
				return
			}
		}
		select {
		case <-req.Context().Done():
			return
		case <-server.ctx.Done():
			return
		case <-timer.C:
		}
	}
}
