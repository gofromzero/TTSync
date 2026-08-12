package mail

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	PublicOrigin string
	OutboxDir    string
	SMTPAddr     string
	SMTPFrom     string
	SMTPUsername string
	SMTPPassword string
}

func Deliver(ctx context.Context, config Config, to, rawToken string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.ContainsAny(to+config.SMTPFrom, "\r\n") {
		return fmt.Errorf("invalid mail address")
	}
	from := config.SMTPFrom
	if from == "" {
		from = "noreply@localhost"
	}
	body := "Your request was received."
	if rawToken != "" {
		body = "Verify your email: " + config.PublicOrigin + "/verify?token=" + url.QueryEscape(rawToken)
	}
	message := []byte("To: " + to + "\r\nFrom: " + from + "\r\nSubject: TTSync email verification\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + body + "\r\n")

	if config.OutboxDir != "" {
		if err := os.MkdirAll(config.OutboxDir, 0o700); err != nil {
			return fmt.Errorf("create mail outbox: %w", err)
		}
		if err := os.Chmod(config.OutboxDir, 0o700); err != nil {
			return fmt.Errorf("secure mail outbox: %w", err)
		}
		nameBytes := make([]byte, 16)
		if _, err := rand.Read(nameBytes); err != nil {
			return fmt.Errorf("name outbox message: %w", err)
		}
		file, err := os.OpenFile(filepath.Join(config.OutboxDir, base64.RawURLEncoding.EncodeToString(nameBytes)+".eml"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return fmt.Errorf("create outbox message: %w", err)
		}
		if err := file.Chmod(0o600); err != nil {
			_ = file.Close()
			return fmt.Errorf("secure outbox message: %w", err)
		}
		if _, err := file.Write(message); err != nil {
			_ = file.Close()
			return fmt.Errorf("write outbox message: %w", err)
		}
		if err := file.Close(); err != nil {
			return fmt.Errorf("close outbox message: %w", err)
		}
		return nil
	}

	if config.SMTPAddr == "" || config.SMTPFrom == "" {
		return fmt.Errorf("mail delivery is not configured")
	}
	var auth smtp.Auth
	if config.SMTPUsername != "" || config.SMTPPassword != "" {
		if config.SMTPUsername == "" || config.SMTPPassword == "" {
			return fmt.Errorf("SMTP credentials must be paired")
		}
		host, _, err := net.SplitHostPort(config.SMTPAddr)
		if err != nil {
			return fmt.Errorf("parse SMTP address: %w", err)
		}
		auth = smtp.PlainAuth("", config.SMTPUsername, config.SMTPPassword, host)
	}
	if err := smtp.SendMail(config.SMTPAddr, auth, config.SMTPFrom, []string{to}, message); err != nil {
		return fmt.Errorf("send mail: %w", err)
	}
	return nil
}
