package main

import "testing"

func TestApplicationConfigFromEnvironmentRejectsMissingDatabaseURL(t *testing.T) {
	for _, value := range []string{"", " \t\r\n "} {
		t.Setenv("DATABASE_URL", value)
		if _, err := applicationConfigFromEnvironment(); err == nil {
			t.Fatalf("DATABASE_URL %q should be rejected", value)
		}
	}
}

func TestApplicationConfigFromEnvironmentPreservesValidValues(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.test/ttsync")
	t.Setenv("HTTP_ADDR", "127.0.0.1:9080")

	config, err := applicationConfigFromEnvironment()
	if err != nil {
		t.Fatalf("applicationConfigFromEnvironment() error = %v", err)
	}
	if config.DatabaseURL != "postgres://example.test/ttsync" {
		t.Fatalf("DatabaseURL = %q", config.DatabaseURL)
	}
	if config.HTTPAddr != "127.0.0.1:9080" {
		t.Fatalf("HTTPAddr = %q", config.HTTPAddr)
	}
}
