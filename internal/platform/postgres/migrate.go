package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/gofromzero/ttsync/db/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

const migrationAdvisoryLockKey int64 = 0x545453594e430001

var migrationFilename = regexp.MustCompile(`^([0-9]{6})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$`)

type migration struct {
	version  int64
	name     string
	checksum string
	sql      string
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	return migrateFS(ctx, pool, migrations.Files)
}

func migrateFS(ctx context.Context, pool *pgxpool.Pool, migrationFS fs.FS) (returnErr error) {
	loaded, err := loadMigrations(migrationFS)
	if err != nil {
		return err
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	locked := false
	defer func() {
		if !locked {
			conn.Release()
			return
		}
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		unlockErr := conn.QueryRow(unlockCtx, `SELECT pg_advisory_unlock($1)`, migrationAdvisoryLockKey).Scan(&unlocked)
		if unlockErr != nil || !unlocked {
			rawConn := conn.Hijack()
			_ = rawConn.Close(unlockCtx)
			if returnErr == nil {
				if unlockErr != nil {
					returnErr = fmt.Errorf("release migration advisory lock: %w", unlockErr)
				} else {
					returnErr = fmt.Errorf("release migration advisory lock: lock was not held")
				}
			}
			return
		}
		conn.Release()
	}()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationAdvisoryLockKey); err != nil {
		return fmt.Errorf("acquire migration advisory lock: %w", err)
	}
	locked = true

	applied, err := readAppliedMigrations(ctx, conn)
	if err != nil {
		return err
	}
	if err := validateAppliedMigrations(loaded, applied); err != nil {
		return err
	}

	for _, item := range loaded {
		if _, ok := applied[item.version]; ok {
			continue
		}
		if err := applyMigration(ctx, conn, item); err != nil {
			return err
		}
	}
	return nil
}

func readAppliedMigrations(ctx context.Context, conn *pgxpool.Conn) (map[int64]string, error) {
	var exists bool
	if err := conn.QueryRow(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check migration ledger: %w", err)
	}
	applied := make(map[int64]string)
	if !exists {
		return applied, nil
	}

	rows, err := conn.Query(ctx, `SELECT version, checksum FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("read migration ledger: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var version int64
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return nil, fmt.Errorf("scan migration ledger: %w", err)
		}
		applied[version] = checksum
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate migration ledger: %w", err)
	}
	return applied, nil
}

func validateAppliedMigrations(loaded []migration, applied map[int64]string) error {
	known := make(map[int64]migration, len(loaded))
	for _, item := range loaded {
		known[item.version] = item
	}
	for version, checksum := range applied {
		item, ok := known[version]
		if !ok {
			return fmt.Errorf("migration ledger contains unknown version %d", version)
		}
		if checksum != item.checksum {
			return fmt.Errorf("migration %d checksum mismatch: ledger %s, embedded %s", version, checksum, item.checksum)
		}
	}
	return nil
}

func applyMigration(ctx context.Context, conn *pgxpool.Conn, item migration) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration %d: %w", item.version, err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if _, err := tx.Exec(ctx, item.sql); err != nil {
		return fmt.Errorf("execute migration %d (%s): %w", item.version, item.name, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`, item.version, item.checksum); err != nil {
		return fmt.Errorf("record migration %d: %w", item.version, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %d: %w", item.version, err)
	}
	return nil
}

func loadMigrations(migrationFS fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, ".")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	items := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			return nil, fmt.Errorf("invalid migration entry %q: directories are not allowed", entry.Name())
		}
		matches := migrationFilename.FindStringSubmatch(entry.Name())
		if matches == nil {
			return nil, fmt.Errorf("invalid migration filename %q", entry.Name())
		}
		version, err := strconv.ParseInt(matches[1], 10, 64)
		if err != nil || version == 0 {
			return nil, fmt.Errorf("invalid migration version in %q", entry.Name())
		}
		contents, err := fs.ReadFile(migrationFS, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		digest := sha256.Sum256(contents)
		items = append(items, migration{
			version:  version,
			name:     entry.Name(),
			checksum: hex.EncodeToString(digest[:]),
			sql:      string(contents),
		})
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("no migrations found")
	}
	sort.Slice(items, func(left, right int) bool { return items[left].version < items[right].version })
	for index, item := range items {
		expected := int64(index + 1)
		if item.version != expected {
			return nil, fmt.Errorf("migration %q has version %d, expected version %d", item.name, item.version, expected)
		}
	}
	return items, nil
}
