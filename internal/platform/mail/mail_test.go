package mail

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestDeliverWritesTokenAndGenericOutboxMessages(t *testing.T) {
	directory := t.TempDir() + "/outbox"
	config := Config{PublicOrigin: "https://localhost:8443", OutboxDir: directory}
	if err := Deliver(context.Background(), config, "user@example.com", "secret-token"); err != nil {
		t.Fatalf("Deliver(token) error = %v", err)
	}
	if err := Deliver(context.Background(), config, "other@example.com", ""); err != nil {
		t.Fatalf("Deliver(generic) error = %v", err)
	}

	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Name() == entries[1].Name() {
		t.Fatalf("outbox entries = %#v", entries)
	}
	directoryInfo, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode = %o", directoryInfo.Mode().Perm())
	}

	messages := make([]string, 0, 2)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Fatalf("file mode = %o", info.Mode().Perm())
		}
		contents, err := os.ReadFile(directory + "/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		messages = append(messages, string(contents))
	}
	joined := strings.Join(messages, "\n---\n")
	if strings.Count(joined, "https://localhost:8443/verify?token=secret-token") != 1 {
		t.Fatalf("token link count != 1:\n%s", joined)
	}
	for _, message := range messages {
		if strings.Contains(message, "other@example.com") && (strings.Contains(message, "/verify?") || strings.Contains(message, "secret-token")) {
			t.Fatalf("generic message contains link or token:\n%s", message)
		}
	}
}

func TestDeliverReturnsUnreachableSMTPError(t *testing.T) {
	err := Deliver(context.Background(), Config{
		PublicOrigin: "https://localhost:8443",
		SMTPAddr:     "127.0.0.1:1",
		SMTPFrom:     "noreply@example.com",
	}, "user@example.com", "secret-token")
	if err == nil {
		t.Fatal("Deliver() error = nil, want unreachable SMTP error")
	}
}
