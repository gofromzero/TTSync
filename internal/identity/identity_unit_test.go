package identity

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNormalizeEmailPreservesTrimmedDisplayAndBuildsLowercaseKey(t *testing.T) {
	display, key, err := normalizeEmail(" \tAlice.Example+Tag@Example.COM\n")
	if err != nil {
		t.Fatalf("normalize email: %v", err)
	}
	if display != "Alice.Example+Tag@Example.COM" {
		t.Fatalf("display = %q", display)
	}
	if key != "alice.example+tag@example.com" {
		t.Fatalf("key = %q", key)
	}
}

func TestNewVerificationTokenReturnsRawButKeepsOnlyDigestAndExactExpiry(t *testing.T) {
	now := time.Date(2026, 8, 12, 9, 30, 0, 0, time.UTC)
	random := func(dst []byte) (int, error) {
		for i := range dst {
			dst[i] = byte(i + 1)
		}
		return len(dst), nil
	}
	token, err := newVerificationToken(now, random)
	if err != nil {
		t.Fatalf("new token: %v", err)
	}
	rawBytes, err := base64.RawURLEncoding.DecodeString(token.raw)
	if err != nil {
		t.Fatalf("token is not URL-safe base64: %v", err)
	}
	if len(rawBytes) < 16 {
		t.Fatalf("token entropy bytes = %d", len(rawBytes))
	}
	wantDigest := sha256.Sum256(rawBytes)
	if token.digest != wantDigest {
		t.Fatalf("digest = %x, want %x", token.digest, wantDigest)
	}
	if token.expiresAt != now.Add(24*time.Hour) {
		t.Fatalf("expiry = %s", token.expiresAt)
	}
	if strings.Contains(string(token.digest[:]), token.raw) {
		t.Fatal("stored digest contains raw token")
	}
}

func TestLimiterEnforcesMinuteAndHourBoundaries(t *testing.T) {
	start := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	var limiter limiter
	if !limiter.allow("target", start, 1, 5) {
		t.Fatal("first target request denied")
	}
	if limiter.allow("target", start.Add(59*time.Second), 1, 5) {
		t.Fatal("second target request inside minute allowed")
	}
	for i := 1; i < 5; i++ {
		if !limiter.allow("target", start.Add(time.Duration(i)*time.Minute), 1, 5) {
			t.Fatalf("target request %d denied", i+1)
		}
	}
	if limiter.allow("target", start.Add(5*time.Minute), 1, 5) {
		t.Fatal("sixth target request inside hour allowed")
	}
	if !limiter.allow("target", start.Add(time.Hour), 1, 5) {
		t.Fatal("request at exact hour boundary denied")
	}
}

func TestModuleLimitersShareIdentityIPBucketAndDoNotKeepRawTokens(t *testing.T) {
	now := time.Date(2026, 8, 12, 11, 0, 0, 0, time.UTC)
	module := &Module{limits: &limiter{}}
	for i := 0; i < 20; i++ {
		target := "target-" + string(rune('a'+i))
		if module.identityRateLimited(target, "192.0.2.1", now.Add(time.Duration(i)*time.Minute)) {
			t.Fatalf("identity IP request %d was limited", i+1)
		}
	}
	if !module.identityRateLimited("target-z", "192.0.2.1", now.Add(20*time.Minute)) {
		t.Fatal("21st combined registration/resend IP request was allowed")
	}
	raw := "secret-verification-token"
	module.verificationRateLimited(raw, "192.0.2.2", now)
	for key := range module.limits.entries {
		if strings.Contains(key, raw) {
			t.Fatalf("limiter key kept raw token: %q", key)
		}
	}
}

func TestValidatePasswordUsesPrintableUnicodeRuneBoundsWithoutNormalization(t *testing.T) {
	valid := []string{
		strings.Repeat("界", 15),
		strings.Repeat("a", 128),
		"  " + strings.Repeat("x", 13),
	}
	for _, password := range valid {
		if err := validatePassword(password); err != nil {
			t.Errorf("valid password %q: %v", password, err)
		}
	}
	for _, password := range []string{
		strings.Repeat("界", 14),
		strings.Repeat("a", 129),
		strings.Repeat("a", 14) + "\n",
		"correct horse battery staple",
	} {
		if err := validatePassword(password); !errors.Is(err, ErrInvalidPassword) {
			t.Errorf("invalid password %q error = %v", password, err)
		}
	}
}

func TestHashPasswordProducesVerifiableArgon2idEncoding(t *testing.T) {
	salt := bytes.Repeat([]byte{0x5a}, 16)
	random := func(dst []byte) (int, error) { return copy(dst, salt), nil }
	encoded, err := hashPassword("0123456789abcde", random)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("encoded hash parameters = %q", encoded)
	}
	if !verifyPassword("0123456789abcde", encoded) {
		t.Fatal("encoded hash did not verify")
	}
	if verifyPassword("different-password", encoded) {
		t.Fatal("different password verified")
	}
}

func TestNormalizeEmailRejectsMalformedAndOverlongAddresses(t *testing.T) {
	local := strings.Repeat("a", 243)
	for _, input := range []string{
		"not-an-email",
		"Display Name <a@example.com>",
		local + "@example.com",
	} {
		if _, _, err := normalizeEmail(input); !errors.Is(err, ErrInvalidEmail) {
			t.Errorf("normalizeEmail(%q) error = %v", input, err)
		}
	}
}
