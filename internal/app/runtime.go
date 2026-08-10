package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/gofromzero/ttsync/internal/httpapi"
	"github.com/gofromzero/ttsync/internal/platform/postgres"
)

type Config struct {
	DatabaseURL string
	HTTPAddr    string

	openDatabase func(context.Context, string) (func(context.Context) error, func(), error)
}

func Run(ctx context.Context, config Config) error {
	openDatabase := config.openDatabase
	if openDatabase == nil {
		openDatabase = func(ctx context.Context, databaseURL string) (func(context.Context) error, func(), error) {
			pool, err := postgres.Open(ctx, databaseURL)
			if err != nil {
				return nil, nil, err
			}
			return postgres.Health(pool), pool.Close, nil
		}
	}

	ready, closeDatabase, err := openDatabase(ctx, config.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer closeDatabase()

	listener, err := net.Listen("tcp", config.HTTPAddr)
	if err != nil {
		return fmt.Errorf("serve HTTP: %w", err)
	}
	defer listener.Close()

	server := &http.Server{
		Addr: config.HTTPAddr,
		Handler: httpapi.New(httpapi.Config{
			Ready: ready,
			Web:   httpapi.WebAssets(),
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()

	select {
	case err := <-serveErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown HTTP: %w", err)
		}
		if err := <-serveErrors; !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	}
}
