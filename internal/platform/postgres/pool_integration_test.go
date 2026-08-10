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

func stopTestPostgres(t *testing.T, ctx context.Context, containerTarget string) {
	t.Helper()

	inspect := exec.CommandContext(
		ctx,
		"docker",
		"inspect",
		"--format",
		`{{.Id}}|{{.Name}}|{{index .Config.Labels "ttsync.task"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project"}}`,
		containerTarget,
	)
	metadata, err := inspect.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect test PostgreSQL container: %v: %s", err, metadata)
	}
	parts := strings.Split(strings.TrimSpace(string(metadata)), "|")
	if len(parts) != 5 {
		t.Fatalf("refusing to stop container with malformed metadata %q", metadata)
	}
	containerID, containerName := parts[0], strings.TrimPrefix(parts[1], "/")
	if containerTarget != containerID && containerTarget != containerName {
		t.Fatalf("refusing to stop non-exact container target %q", containerTarget)
	}

	isTaskContainer := parts[2] == "issue-30-task2" && strings.HasPrefix(containerName, "ttsync-b01-task2-")
	expectedComposeProject := os.Getenv("TTSYNC_TEST_COMPOSE_PROJECT")
	isComposePostgres := expectedComposeProject != "" && parts[3] == "postgres" && parts[4] == expectedComposeProject
	if !isTaskContainer && !isComposePostgres {
		t.Fatalf("refusing to stop container %q with untrusted labels", containerTarget)
	}

	stop := exec.CommandContext(ctx, "docker", "stop", containerID)
	if output, err := stop.CombinedOutput(); err != nil {
		t.Fatalf("stop real PostgreSQL container: %v: %s", err, output)
	}
}
