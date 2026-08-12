package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/gofromzero/ttsync/internal/httpapi"
	"github.com/gofromzero/ttsync/internal/identity"
	"github.com/gofromzero/ttsync/internal/platform/mail"
	"github.com/gofromzero/ttsync/internal/platform/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	DatabaseURL  string
	HTTPAddr     string
	PublicOrigin string
	Mail         mail.Config

	openDatabase func(context.Context, string) (*pgxpool.Pool, func(context.Context) error, func(), error)
}

func Run(ctx context.Context, config Config) error {
	openDatabase := config.openDatabase
	if openDatabase == nil {
		openDatabase = func(ctx context.Context, databaseURL string) (*pgxpool.Pool, func(context.Context) error, func(), error) {
			pool, err := postgres.Open(ctx, databaseURL)
			if err != nil {
				return nil, nil, nil, err
			}
			return pool, postgres.Health(pool), pool.Close, nil
		}
	}

	pool, ready, closeDatabase, err := openDatabase(ctx, config.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer closeDatabase()
	mailConfig := config.Mail
	mailConfig.PublicOrigin = config.PublicOrigin
	identityModule := identity.New(pool, func(ctx context.Context, to, rawToken string) error {
		return mail.Deliver(ctx, mailConfig, to, rawToken)
	})

	listener, err := net.Listen("tcp", config.HTTPAddr)
	if err != nil {
		return fmt.Errorf("serve HTTP: %w", err)
	}
	defer listener.Close()

	server := &http.Server{
		Addr: config.HTTPAddr,
		Handler: httpapi.New(httpapi.Config{
			Ready:              ready,
			Web:                httpapi.WebAssets(),
			PublicOrigin:       config.PublicOrigin,
			Register:           identityModule.Register,
			ResendVerification: identityModule.ResendVerification,
			VerifyEmail:        identityModule.VerifyEmail,
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
