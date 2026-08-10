//go:build integration

package postgres

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestHealth(t *testing.T) {
	databaseURL := os.Getenv("TTSYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("TTSYNC_TEST_DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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

	containerName := os.Getenv("TTSYNC_TEST_POSTGRES_CONTAINER")
	if containerName == "" {
		return
	}

	stopTestPostgres(t, ctx, containerName)
	for {
		pingCtx, cancelPing := context.WithTimeout(context.Background(), time.Second)
		err := health(pingCtx)
		cancelPing()
		if err != nil {
			break
		}

		select {
		case <-ctx.Done():
			t.Fatal("Health(ctx) remained healthy after real PostgreSQL stopped")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func stopTestPostgres(t *testing.T, ctx context.Context, containerName string) {
	t.Helper()

	if !strings.HasPrefix(containerName, "ttsync-b01-task2-") {
		t.Fatalf("refusing to stop unexpected container %q", containerName)
	}

	inspect := exec.CommandContext(
		ctx,
		"docker",
		"inspect",
		"--format",
		`{{.Name}}|{{index .Config.Labels "ttsync.task"}}`,
		containerName,
	)
	metadata, err := inspect.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect test PostgreSQL container: %v: %s", err, metadata)
	}
	wantMetadata := "/" + containerName + "|issue-30-task2"
	if actual := strings.TrimSpace(string(metadata)); actual != wantMetadata {
		t.Fatalf("refusing to stop container with metadata %q, want %q", actual, wantMetadata)
	}

	stop := exec.CommandContext(ctx, "docker", "stop", containerName)
	if output, err := stop.CombinedOutput(); err != nil {
		t.Fatalf("stop real PostgreSQL container: %v: %s", err, output)
	}
}
