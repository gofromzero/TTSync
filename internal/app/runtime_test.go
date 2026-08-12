package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/gofromzero/ttsync/internal/platform/mail"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRunShutsDownAndClosesDatabase(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	opened := make(chan struct{})
	closed := make(chan struct{})

	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Config{
			DatabaseURL:  "test-only",
			HTTPAddr:     "127.0.0.1:0",
			PublicOrigin: "https://localhost:8443",
			Mail:         mail.Config{OutboxDir: t.TempDir()},
			openDatabase: func(context.Context, string) (*pgxpool.Pool, func(context.Context) error, func(), error) {
				close(opened)
				return nil, func(context.Context) error { return nil }, func() { close(closed) }, nil
			},
		})
	}()

	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("database was not opened")
	}
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not shut down within 5 seconds")
	}

	select {
	case <-closed:
	default:
		t.Fatal("database was not closed")
	}
}

func TestRunReturnsListenErrorAndClosesDatabase(t *testing.T) {
	closed := false

	err := Run(context.Background(), Config{
		DatabaseURL:  "test-only",
		HTTPAddr:     "127.0.0.1:-1",
		PublicOrigin: "https://localhost:8443",
		Mail:         mail.Config{OutboxDir: t.TempDir()},
		openDatabase: func(context.Context, string) (*pgxpool.Pool, func(context.Context) error, func(), error) {
			return nil, func(context.Context) error { return nil }, func() { closed = true }, nil
		},
	})

	if err == nil || !strings.Contains(err.Error(), "serve HTTP") {
		t.Fatalf("Run() error = %v, want serve HTTP error", err)
	}
	if !closed {
		t.Fatal("database was not closed after listen error")
	}
}

func TestRunReturnsDatabaseOpenError(t *testing.T) {
	want := errors.New("database unavailable")

	err := Run(context.Background(), Config{
		DatabaseURL:  "test-only",
		HTTPAddr:     "127.0.0.1:0",
		PublicOrigin: "https://localhost:8443",
		Mail:         mail.Config{OutboxDir: t.TempDir()},
		openDatabase: func(context.Context, string) (*pgxpool.Pool, func(context.Context) error, func(), error) {
			return nil, nil, nil, want
		},
	})

	if !errors.Is(err, want) {
		t.Fatalf("Run() error = %v, want wrapped %v", err, want)
	}
}
