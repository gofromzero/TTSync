package postgres

import (
	"context"
	"fmt"

	"github.com/gofromzero/ttsync/internal/platform/postgres/sqlc"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse PostgreSQL config: %w", err)
	}

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping PostgreSQL: %w", err)
	}
	return pool, nil
}

func Health(pool *pgxpool.Pool) func(context.Context) error {
	queries := sqlc.New(pool)
	return func(ctx context.Context) error {
		ready, err := queries.Health(ctx)
		if err != nil {
			return fmt.Errorf("query PostgreSQL readiness: %w", err)
		}
		if ready != 1 {
			return fmt.Errorf("query PostgreSQL readiness: unexpected value %d", ready)
		}
		return nil
	}
}
