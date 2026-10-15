package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"stockgame/backend-go/internal/game"
)

func main() {
	if err := run(); err != nil {
		slog.Error("stockgame stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	config := game.ConfigFromEnv()
	app, err := game.New(config)
	if err != nil {
		return err
	}
	defer app.Close()
	host, port := os.Getenv("REMASTER_HOST"), os.Getenv("REMASTER_PORT")
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "8321"
	}
	server := &http.Server{Addr: net.JoinHostPort(host, port), Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	failure := make(chan error, 1)
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}
	go func() {
		slog.Info("Go game API listening", "address", listener.Addr().String(), "ledger", "legacy-authoritative")
		failure <- server.Serve(listener)
	}()
	select {
	case err = <-failure:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	app.StopStreams()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}
