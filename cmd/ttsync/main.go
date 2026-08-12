package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gofromzero/ttsync/internal/app"
	"github.com/gofromzero/ttsync/internal/platform/mail"
)

func main() {
	config, err := applicationConfigFromEnvironment()
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, config); err != nil {
		log.Fatal(err)
	}
}

func applicationConfigFromEnvironment() (app.Config, error) {
	databaseURL := os.Getenv("DATABASE_URL")
	if strings.TrimSpace(databaseURL) == "" {
		return app.Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	httpAddr := os.Getenv("HTTP_ADDR")
	if httpAddr == "" {
		httpAddr = ":8080"
	}
	publicOrigin := os.Getenv("PUBLIC_ORIGIN")
	if publicOrigin == "" {
		publicOrigin = "https://localhost:8443"
	}
	parsedOrigin, err := url.Parse(publicOrigin)
	if err != nil || parsedOrigin.Scheme != "https" || parsedOrigin.Host == "" || parsedOrigin.User != nil || parsedOrigin.RawQuery != "" || parsedOrigin.Fragment != "" || parsedOrigin.RawPath != "" || parsedOrigin.Opaque != "" || parsedOrigin.Path != "" && parsedOrigin.Path != "/" {
		return app.Config{}, fmt.Errorf("PUBLIC_ORIGIN must be an absolute HTTPS origin")
	}
	originHost := strings.ToLower(parsedOrigin.Host)
	originHost = strings.TrimSuffix(originHost, ":443")
	publicOrigin = "https://" + originHost

	mailConfig := mail.Config{
		PublicOrigin: publicOrigin,
		OutboxDir:    os.Getenv("MAIL_OUTBOX_DIR"),
		SMTPAddr:     os.Getenv("SMTP_ADDR"),
		SMTPFrom:     os.Getenv("SMTP_FROM"),
		SMTPUsername: os.Getenv("SMTP_USERNAME"),
		SMTPPassword: os.Getenv("SMTP_PASSWORD"),
	}
	outboxSet := strings.TrimSpace(mailConfig.OutboxDir) != ""
	smtpSet := strings.TrimSpace(mailConfig.SMTPAddr) != "" || strings.TrimSpace(mailConfig.SMTPFrom) != "" || strings.TrimSpace(mailConfig.SMTPUsername) != "" || strings.TrimSpace(mailConfig.SMTPPassword) != ""
	if outboxSet && smtpSet {
		return app.Config{}, fmt.Errorf("MAIL_OUTBOX_DIR and SMTP configuration are mutually exclusive")
	}
	if !outboxSet && !smtpSet {
		mailConfig.OutboxDir = "/tmp/ttsync-outbox"
	} else if smtpSet {
		if strings.TrimSpace(mailConfig.SMTPAddr) == "" || strings.TrimSpace(mailConfig.SMTPFrom) == "" {
			return app.Config{}, fmt.Errorf("SMTP_ADDR and SMTP_FROM are required together")
		}
		if (mailConfig.SMTPUsername == "") != (mailConfig.SMTPPassword == "") {
			return app.Config{}, fmt.Errorf("SMTP_USERNAME and SMTP_PASSWORD are required together")
		}
	}
	return app.Config{
		DatabaseURL:  databaseURL,
		HTTPAddr:     httpAddr,
		PublicOrigin: publicOrigin,
		Mail:         mailConfig,
	}, nil
}
