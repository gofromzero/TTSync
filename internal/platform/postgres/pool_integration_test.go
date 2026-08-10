//go:build integration

package postgres

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestHealth(t *testing.T) {
	databaseURL := os.Getenv("TTSYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("TTSYNC_TEST_DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open real PostgreSQL: %v", err)
	}
	t.Cleanup(pool.Close)

	health := Health(pool)
	if err := health(ctx); err != nil {
		t.Fatalf("healthy PostgreSQL readiness: %v", err)
	}

	if _, err := Open(ctx, "postgres://%zz"); err == nil {
		t.Fatal("Open(invalid DSN) error = nil, want error")
	}

	pool.Close()
	if err := health(ctx); err == nil {
		t.Fatal("Health(closed pool) error = nil, want error")
	}
}
