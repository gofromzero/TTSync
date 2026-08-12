//go:build integration

package postgres

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrationIsIdempotentAndRejectsChecksumMismatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := newMigrationTestPool(t, ctx)

	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("first Migrate() error = %v", err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("second Migrate() error = %v", err)
	}

	var version int64
	var checksum string
	var appliedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT version, checksum, applied_at FROM schema_migrations`).Scan(&version, &checksum, &appliedAt); err != nil {
		t.Fatalf("read schema_migrations ledger: %v", err)
	}
	if version != 1 {
		t.Fatalf("ledger version = %d, want 1", version)
	}
	if len(checksum) != 64 {
		t.Fatalf("ledger checksum length = %d, want 64", len(checksum))
	}
	if appliedAt.IsZero() {
		t.Fatal("ledger applied_at is zero")
	}

	var tableNames []string
	rows, err := pool.Query(ctx, `
		SELECT table_name
		FROM information_schema.tables
		WHERE table_schema = current_schema()
		ORDER BY table_name`)
	if err != nil {
		t.Fatalf("list migrated tables: %v", err)
	}
	for rows.Next() {
		var tableName string
		if err := rows.Scan(&tableName); err != nil {
			rows.Close()
			t.Fatalf("scan migrated table: %v", err)
		}
		tableNames = append(tableNames, tableName)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate migrated tables: %v", err)
	}
	rows.Close()
	wantTables := []string{"accounts", "identity_security_events", "schema_migrations", "verification_tokens"}
	if !slices.Equal(tableNames, wantTables) {
		t.Fatalf("migrated tables = %v, want %v", tableNames, wantTables)
	}

	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1`); err != nil {
		t.Fatalf("tamper applied checksum: %v", err)
	}
	if err := Migrate(ctx, pool); err == nil || !contains(err.Error(), "checksum mismatch") {
		t.Fatalf("Migrate() after checksum tamper error = %v, want checksum mismatch", err)
	}
}

func newMigrationTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TTSYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("TTSYNC_TEST_DATABASE_URL is required")
	}

	adminPool, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open real PostgreSQL admin pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		t.Fatalf("generate test schema suffix: %v", err)
	}
	schemaName := "ttsync_migration_" + hex.EncodeToString(randomBytes)
	if _, err := adminPool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schemaName}.Sanitize()); err != nil {
		t.Fatalf("create empty migration schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := adminPool.Exec(cleanupCtx, "DROP SCHEMA "+pgx.Identifier{schemaName}.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("drop migration test schema: %v", err)
		}
	})

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse migration test pool config: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open migration test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping migration test pool: %v", err)
	}
	return pool
}
