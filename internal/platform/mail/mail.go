package mail

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	PublicOrigin string
	OutboxDir    string
	SMTPAddr     string
	SMTPFrom     string
	SMTPUsername string
	SMTPPassword string
	smtpRootCAs  *x509.CertPool
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
	host, _, err := net.SplitHostPort(config.SMTPAddr)
	if err != nil {
		return fmt.Errorf("parse SMTP address: %w", err)
	}
	if host == "" {
		return fmt.Errorf("parse SMTP address: empty host")
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", config.SMTPAddr)
	if err != nil {
		return fmt.Errorf("connect SMTP: %w", err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set SMTP deadline: %w", err)
	}
	stopClose := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopClose()
	client, err := smtp.NewClient(connection, host)
	if err != nil {
		return fmt.Errorf("open SMTP client: %w", err)
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); !ok {
		return fmt.Errorf("SMTP server does not support required STARTTLS")
	}
	if err := client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, RootCAs: config.smtpRootCAs}); err != nil {
		return fmt.Errorf("start SMTP TLS: %w", err)
	}
	if config.SMTPUsername != "" || config.SMTPPassword != "" {
		if config.SMTPUsername == "" || config.SMTPPassword == "" {
			return fmt.Errorf("SMTP credentials must be paired")
		}
		if err := client.Auth(smtp.PlainAuth("", config.SMTPUsername, config.SMTPPassword, host)); err != nil {
			return fmt.Errorf("authenticate SMTP: %w", err)
		}
	}
	if err := client.Mail(config.SMTPFrom); err != nil {
		return fmt.Errorf("set SMTP sender: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("set SMTP recipient: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("start SMTP message: %w", err)
	}
	if _, err := writer.Write(message); err != nil {
		_ = writer.Close()
		return fmt.Errorf("write SMTP message: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("finish SMTP message: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("quit SMTP: %w", err)
	}
	return nil
}
