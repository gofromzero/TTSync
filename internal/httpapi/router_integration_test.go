//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofromzero/ttsync/internal/identity"
	"github.com/gofromzero/ttsync/internal/platform/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestHTTPAcceptsIdentityGeneratedVerificationToken(t *testing.T) {
	ctx := context.Background()
	pool := newHTTPIdentityTestPool(t, ctx)
	generatedToken := ""
	module := identity.New(pool, func(_ context.Context, _ string, rawToken string) error {
		generatedToken = rawToken
		return nil
	})
	if _, err := module.Register(ctx, identity.RegisterCommand{
		Email: "http-generated-token@example.com", Password: "0123456789abcde", IP: "198.51.100.70", RequestID: "register-generated-token",
	}); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if generatedToken == "" {
		t.Fatal("identity did not deliver a generated token")
	}

	handler := New(Config{PublicOrigin: "https://localhost:8443", VerifyEmail: module.VerifyEmail})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/accounts/verification", strings.NewReader(`{"token":"`+generatedToken+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://localhost:8443")
	request.Header.Set("X-CSRF-Token", "csrf-token")
	request.AddCookie(&http.Cookie{Name: "__Host-ttsync-csrf", Value: "csrf-token"})
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.String() != "{\"verified\":true}\n" {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
}

func newHTTPIdentityTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TTSYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("TTSYNC_TEST_DATABASE_URL is required")
	}
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	schema := fmt.Sprintf("http_identity_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		adminPool.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := adminPool.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Errorf("drop schema: %v", err)
		}
		adminPool.Close()
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := postgres.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}
