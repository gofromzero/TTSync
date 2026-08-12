package identity

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

var ErrInvalidEmail = errors.New("invalid email")
var ErrInvalidPassword = errors.New("invalid password")

const (
	argonMemory      = 19 * 1024
	argonIterations  = 2
	argonParallelism = 1
	argonSaltLength  = 16
	argonKeyLength   = 32
)

var breachedPasswords = map[string]struct{}{
	"correct horse battery staple": {},
	"passwordpassword":             {},
	"123456789012345":              {},
}

type verificationToken struct {
	raw       string
	digest    [sha256.Size]byte
	expiresAt time.Time
}

type limiter struct {
	mu      sync.Mutex
	entries map[string][]time.Time
}

func normalizeEmail(input string) (string, string, error) {
	display := strings.TrimSpace(input)
	parsed, err := mail.ParseAddress(display)
	if err != nil || parsed.Address != display || len(display) > 254 {
		return "", "", ErrInvalidEmail
	}
	return display, strings.ToLower(display), nil
}

func validatePassword(password string) error {
	runes := utf8.RuneCountInString(password)
	if !utf8.ValidString(password) || runes < 15 || runes > 128 {
		return ErrInvalidPassword
	}
	for _, r := range password {
		if !unicode.IsPrint(r) {
			return ErrInvalidPassword
		}
	}
	if _, found := breachedPasswords[password]; found {
		return ErrInvalidPassword
	}
	return nil
}

func newVerificationToken(now time.Time, random func([]byte) (int, error)) (verificationToken, error) {
	bytes := make([]byte, 16)
	if n, err := random(bytes); err != nil || n != len(bytes) {
		if err == nil {
			err = errors.New("short random read")
		}
		return verificationToken{}, fmt.Errorf("generate verification token: %w", err)
	}
	raw := base64.RawURLEncoding.EncodeToString(bytes)
	return verificationToken{raw: raw, digest: sha256.Sum256(bytes), expiresAt: now.Add(24 * time.Hour)}, nil
}

// ponytail: 单实例进程内窗口；部署多实例且限速偏差成为问题时改共享存储。
func (l *limiter) allow(key string, now time.Time, minuteLimit, hourLimit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = make(map[string][]time.Time)
	}
	hourStart := now.Add(-time.Hour)
	entries := l.entries[key]
	kept := entries[:0]
	for _, at := range entries {
		if at.After(hourStart) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= hourLimit {
		l.entries[key] = kept
		return false
	}
	minuteStart := now.Add(-time.Minute)
	minuteCount := 0
	for _, at := range kept {
		if at.After(minuteStart) {
			minuteCount++
		}
	}
	if minuteCount >= minuteLimit {
		l.entries[key] = kept
		return false
	}
	l.entries[key] = append(kept, now)
	return true
}

func hashPassword(password string, random func([]byte) (int, error)) (string, error) {
	salt := make([]byte, argonSaltLength)
	if n, err := random(salt); err != nil || n != len(salt) {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLength)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}
