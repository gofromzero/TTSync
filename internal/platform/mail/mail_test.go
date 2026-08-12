package mail

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http/httptest"
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

func TestDeliverRefusesSMTPWithoutSTARTTLSBeforeMessageBody(t *testing.T) {
	listener, _, result := smtpServer(t, false, 0)
	err := Deliver(context.Background(), Config{
		PublicOrigin: "https://localhost:8443",
		SMTPAddr:     listener.Addr().String(),
		SMTPFrom:     "noreply@example.com",
		SMTPUsername: "mailer",
		SMTPPassword: "plaintext-secret",
	}, "user@example.com", "secret-token")
	if err == nil {
		t.Fatal("Deliver() error = nil, want required STARTTLS error")
	}
	assertNoDeliveryCommands(t, (<-result).commands)
}

func TestDeliverRefusesUntrustedSTARTTLSCertificateBeforeCredentialsOrMessage(t *testing.T) {
	listener, _, result := smtpServer(t, true, 0)
	err := Deliver(context.Background(), Config{
		PublicOrigin: "https://localhost:8443",
		SMTPAddr:     listener.Addr().String(),
		SMTPFrom:     "noreply@example.com",
		SMTPUsername: "mailer",
		SMTPPassword: "plaintext-secret",
	}, "user@example.com", "secret-token")
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("Deliver() error = %v, want untrusted certificate rejection", err)
	}
	assertNoDeliveryCommands(t, (<-result).commands)
}

func assertNoDeliveryCommands(t *testing.T, commands []string) {
	t.Helper()
	for _, command := range commands {
		for _, forbidden := range []string{"AUTH", "MAIL FROM", "RCPT TO", "DATA"} {
			if strings.HasPrefix(command, forbidden) {
				t.Fatalf("SMTP command %q was sent before verified STARTTLS", command)
			}
		}
	}
}

func TestDeliverSendsCredentialsAndMessageOnlyAfterTrustedSTARTTLS(t *testing.T) {
	listener, certificate, result := smtpServer(t, true, 0)
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	err := Deliver(context.Background(), Config{
		PublicOrigin: "https://localhost:8443",
		SMTPAddr:     listener.Addr().String(),
		SMTPFrom:     "noreply@example.com",
		SMTPUsername: "mailer",
		SMTPPassword: "smtp-secret",
		smtpRootCAs:  roots,
	}, "user@example.com", "secret-token")
	if err != nil {
		t.Fatalf("Deliver() error = %v", err)
	}
	capture := <-result
	if capture.tlsVersion < tls.VersionTLS12 {
		t.Fatalf("TLS version = %x, want TLS 1.2+", capture.tlsVersion)
	}
	positions := make(map[string]int)
	for index, command := range capture.commands {
		for _, prefix := range []string{"STARTTLS", "AUTH", "MAIL FROM", "RCPT TO", "DATA"} {
			if strings.HasPrefix(command, prefix) {
				positions[prefix] = index
			}
		}
	}
	if !(positions["STARTTLS"] < positions["AUTH"] && positions["AUTH"] < positions["MAIL FROM"] && positions["MAIL FROM"] < positions["RCPT TO"] && positions["RCPT TO"] < positions["DATA"]) {
		t.Fatalf("SMTP command order = %#v", capture.commands)
	}
	if !strings.Contains(capture.body, "user@example.com") || !strings.Contains(capture.body, "secret-token") {
		t.Fatalf("SMTP body = %q", capture.body)
	}
}

func TestDeliverRefusesSTARTTLSBelowTLS12BeforeCredentialsOrMessage(t *testing.T) {
	listener, certificate, result := smtpServer(t, true, tls.VersionTLS11)
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	err := Deliver(context.Background(), Config{
		PublicOrigin: "https://localhost:8443",
		SMTPAddr:     listener.Addr().String(),
		SMTPFrom:     "noreply@example.com",
		SMTPUsername: "mailer",
		SMTPPassword: "smtp-secret",
		smtpRootCAs:  roots,
	}, "user@example.com", "secret-token")
	if err == nil {
		t.Fatal("Deliver() error = nil, want TLS 1.2 minimum rejection")
	}
	assertNoDeliveryCommands(t, (<-result).commands)
}

type smtpCapture struct {
	commands   []string
	body       string
	tlsVersion uint16
}

func smtpServer(t *testing.T, advertiseSTARTTLS bool, maxTLSVersion uint16) (net.Listener, *x509.Certificate, <-chan smtpCapture) {
	t.Helper()
	fixture := httptest.NewTLSServer(nil)
	serverCertificate := fixture.TLS.Certificates[0]
	certificate := fixture.Certificate()
	fixture.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	result := make(chan smtpCapture, 1)
	go func() {
		capture := smtpCapture{}
		defer func() { result <- capture }()
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		writer := bufio.NewWriter(connection)
		reply := func(message string) { _, _ = writer.WriteString(message); _ = writer.Flush() }
		reply("220 smtp.test ESMTP\r\n")
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				return
			}
			command := strings.TrimSpace(line)
			capture.commands = append(capture.commands, command)
			switch {
			case strings.HasPrefix(command, "EHLO ") && capture.tlsVersion == 0 && advertiseSTARTTLS:
				reply("250-smtp.test\r\n250 STARTTLS\r\n")
			case strings.HasPrefix(command, "EHLO "):
				reply("250 smtp.test\r\n")
			case command == "STARTTLS":
				reply("220 ready\r\n")
				minimum := uint16(tls.VersionTLS12)
				if maxTLSVersion != 0 {
					minimum = tls.VersionTLS10
				}
				tlsConnection := tls.Server(connection, &tls.Config{Certificates: []tls.Certificate{serverCertificate}, MinVersion: minimum, MaxVersion: maxTLSVersion})
				if handshakeErr := tlsConnection.Handshake(); handshakeErr != nil {
					return
				}
				capture.tlsVersion = tlsConnection.ConnectionState().Version
				reader, writer = bufio.NewReader(tlsConnection), bufio.NewWriter(tlsConnection)
			case strings.HasPrefix(command, "AUTH "):
				reply("235 authenticated\r\n")
			case strings.HasPrefix(command, "MAIL FROM") || strings.HasPrefix(command, "RCPT TO"):
				reply("250 ok\r\n")
			case command == "DATA":
				reply("354 send body\r\n")
				var lines []string
				for {
					bodyLine, bodyErr := reader.ReadString('\n')
					if bodyErr != nil {
						return
					}
					if strings.TrimSpace(bodyLine) == "." {
						break
					}
					lines = append(lines, bodyLine)
				}
				capture.body = strings.Join(lines, "")
				reply("250 queued\r\n")
			case command == "QUIT":
				reply("221 bye\r\n")
				return
			default:
				reply("250 ok\r\n")
			}
		}
	}()
	return listener, certificate, result
}
