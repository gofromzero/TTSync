package main

import "testing"

func clearMailEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"PUBLIC_ORIGIN", "MAIL_OUTBOX_DIR", "SMTP_ADDR", "SMTP_FROM", "SMTP_USERNAME", "SMTP_PASSWORD"} {
		t.Setenv(name, "")
	}
}

func TestApplicationConfigFromEnvironmentRejectsMissingDatabaseURL(t *testing.T) {
	clearMailEnvironment(t)
	for _, value := range []string{"", " \t\r\n "} {
		t.Setenv("DATABASE_URL", value)
		if _, err := applicationConfigFromEnvironment(); err == nil {
			t.Fatalf("DATABASE_URL %q should be rejected", value)
		}
	}
}

func TestApplicationConfigFromEnvironmentPreservesValidValues(t *testing.T) {
	clearMailEnvironment(t)
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
	if config.PublicOrigin != "https://localhost:8443" || config.Mail.OutboxDir != "/tmp/ttsync-outbox" {
		t.Fatalf("defaults = origin %q mail %#v", config.PublicOrigin, config.Mail)
	}
}

func TestApplicationConfigFromEnvironmentAcceptsOutboxOrCompleteSMTP(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "outbox", env: map[string]string{"PUBLIC_ORIGIN": "https://EXAMPLE.test:443", "MAIL_OUTBOX_DIR": "/var/lib/ttsync/outbox"}},
		{name: "SMTP without auth", env: map[string]string{"SMTP_ADDR": "smtp.example.test:587", "SMTP_FROM": "noreply@example.test"}},
		{name: "SMTP with auth", env: map[string]string{"SMTP_ADDR": "smtp.example.test:587", "SMTP_FROM": "noreply@example.test", "SMTP_USERNAME": "mailer", "SMTP_PASSWORD": "local-secret"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clearMailEnvironment(t)
			t.Setenv("DATABASE_URL", "postgres://example.test/ttsync")
			for name, value := range test.env {
				t.Setenv(name, value)
			}
			config, err := applicationConfigFromEnvironment()
			if err != nil {
				t.Fatalf("applicationConfigFromEnvironment() error = %v", err)
			}
			if config.PublicOrigin != "https://example.test" && test.name == "outbox" {
				t.Fatalf("PublicOrigin = %q", config.PublicOrigin)
			}
			if test.name == "outbox" && config.Mail.OutboxDir != "/var/lib/ttsync/outbox" {
				t.Fatalf("Mail = %#v", config.Mail)
			}
			if test.name != "outbox" && (config.Mail.SMTPAddr != "smtp.example.test:587" || config.Mail.SMTPFrom != "noreply@example.test" || config.Mail.OutboxDir != "") {
				t.Fatalf("Mail = %#v", config.Mail)
			}
		})
	}
}

func TestApplicationConfigFromEnvironmentCanonicalizesNumericPorts(t *testing.T) {
	tests := []struct {
		origin, want string
	}{
		{origin: "https://example.test:0443", want: "https://example.test"},
		{origin: "https://example.test:08443", want: "https://example.test:8443"},
	}
	for _, test := range tests {
		t.Run(test.origin, func(t *testing.T) {
			clearMailEnvironment(t)
			t.Setenv("DATABASE_URL", "postgres://example.test/ttsync")
			t.Setenv("PUBLIC_ORIGIN", test.origin)
			config, err := applicationConfigFromEnvironment()
			if err != nil {
				t.Fatalf("applicationConfigFromEnvironment() error = %v", err)
			}
			if config.PublicOrigin != test.want {
				t.Fatalf("PublicOrigin = %q, want %q", config.PublicOrigin, test.want)
			}
		})
	}
}

func TestApplicationConfigFromEnvironmentRejectsInvalidOriginAndMail(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "HTTP origin", env: map[string]string{"PUBLIC_ORIGIN": "http://localhost:8443"}},
		{name: "origin userinfo", env: map[string]string{"PUBLIC_ORIGIN": "https://user@localhost:8443"}},
		{name: "origin path", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:8443/path"}},
		{name: "origin query", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:8443?x=1"}},
		{name: "origin fragment", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:8443#fragment"}},
		{name: "origin empty hostname", env: map[string]string{"PUBLIC_ORIGIN": "https://:443"}},
		{name: "origin trailing slash", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:8443/"}},
		{name: "origin empty query marker", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:8443?"}},
		{name: "origin empty fragment marker", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:8443#"}},
		{name: "origin malformed port", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:443:444"}},
		{name: "origin non-numeric port", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:smtp"}},
		{name: "origin zero port", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:0"}},
		{name: "origin out-of-range port", env: map[string]string{"PUBLIC_ORIGIN": "https://localhost:65536"}},
		{name: "SMTP missing from", env: map[string]string{"SMTP_ADDR": "smtp.example.test:587"}},
		{name: "SMTP missing address", env: map[string]string{"SMTP_FROM": "noreply@example.test"}},
		{name: "SMTP username only", env: map[string]string{"SMTP_ADDR": "smtp.example.test:587", "SMTP_FROM": "noreply@example.test", "SMTP_USERNAME": "mailer"}},
		{name: "SMTP password only", env: map[string]string{"SMTP_ADDR": "smtp.example.test:587", "SMTP_FROM": "noreply@example.test", "SMTP_PASSWORD": "local-secret"}},
		{name: "outbox and SMTP", env: map[string]string{"MAIL_OUTBOX_DIR": "/tmp/outbox", "SMTP_ADDR": "smtp.example.test:587", "SMTP_FROM": "noreply@example.test"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clearMailEnvironment(t)
			t.Setenv("DATABASE_URL", "postgres://example.test/ttsync")
			for name, value := range test.env {
				t.Setenv(name, value)
			}
			if _, err := applicationConfigFromEnvironment(); err == nil {
				t.Fatal("applicationConfigFromEnvironment() error = nil")
			}
		})
	}
}
