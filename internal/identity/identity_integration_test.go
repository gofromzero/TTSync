//go:build integration

package identity

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofromzero/ttsync/internal/platform/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

const integrationPassword = "0123456789abcde"

var integrationRandomSeed atomic.Uint32

func TestConcurrentNormalizedRegistrationCreatesOneAccountAndStoresDigestOnly(t *testing.T) {
	ctx := context.Background()
	pool := newIdentityTestPool(t, ctx)
	now := time.Date(2026, 8, 12, 8, 0, 0, 0, time.UTC)
	var accepted atomic.Int32
	var deliveredMu sync.Mutex
	var delivered []string
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			module := testModule(pool, &now, func(_ context.Context, _ string, raw string) error {
				deliveredMu.Lock()
				defer deliveredMu.Unlock()
				delivered = append(delivered, raw)
				return nil
			})
			<-start
			result, err := module.Register(ctx, RegisterCommand{
				Email:       fmt.Sprintf("  Concurrent@Example.COM%s", strings.Repeat(" ", i%2)),
				Password:    integrationPassword,
				RequestTime: now,
				IP:          fmt.Sprintf("192.0.2.%d", i+1),
				RequestID:   fmt.Sprintf("registration-%d", i),
			})
			if err != nil {
				t.Errorf("register %d: %v", i, err)
				return
			}
			if result.Accepted {
				accepted.Add(1)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if accepted.Load() != 8 {
		t.Fatalf("accepted registrations = %d", accepted.Load())
	}

	var accountCount, tokenCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM accounts WHERE email_normalized = 'concurrent@example.com'`).Scan(&accountCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM verification_tokens`).Scan(&tokenCount); err != nil {
		t.Fatal(err)
	}
	if accountCount != 1 || tokenCount != 1 || len(delivered) != 1 {
		t.Fatalf("accounts/tokens/deliveries = %d/%d/%d", accountCount, tokenCount, len(delivered))
	}
	var digest []byte
	if err := pool.QueryRow(ctx, `SELECT token_digest FROM verification_tokens`).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if len(digest) != 32 {
		t.Fatalf("digest length = %d", len(digest))
	}
	assertEventPayloadsExclude(t, ctx, pool, integrationPassword, delivered[0], hex.EncodeToString(digest))
}

func TestResendAndVerificationTokenStates(t *testing.T) {
	ctx := context.Background()
	pool := newIdentityTestPool(t, ctx)

	t.Run("resend invalidates prior generation", func(t *testing.T) {
		now := time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC)
		var delivered []string
		module := testModule(pool, &now, func(_ context.Context, _ string, raw string) error {
			delivered = append(delivered, raw)
			return nil
		})
		registerAccount(t, ctx, module, "resend@example.com", now)
		now = now.Add(time.Minute)
		result, err := module.ResendVerification(ctx, ResendVerificationCommand{Email: " RESEND@example.com ", RequestTime: now, IP: "198.51.100.1", RequestID: "resend-1"})
		if err != nil || !result.Accepted {
			t.Fatalf("resend = %+v, %v", result, err)
		}
		if len(delivered) != 2 || delivered[0] == delivered[1] {
			t.Fatalf("delivered tokens = %v", delivered)
		}
		assertInvalidTokenLeavesPending(t, ctx, module, delivered[0], now, "198.51.100.2")
		var generations, revoked int
		if err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE revoked_at IS NOT NULL) FROM verification_tokens WHERE account_id = (SELECT account_id FROM accounts WHERE email_normalized='resend@example.com')`).Scan(&generations, &revoked); err != nil {
			t.Fatal(err)
		}
		if generations != 2 || revoked != 1 {
			t.Fatalf("generations/revoked = %d/%d", generations, revoked)
		}
	})

	t.Run("expired token", func(t *testing.T) {
		now := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
		var raw string
		module := testModule(pool, &now, func(_ context.Context, _ string, token string) error { raw = token; return nil })
		registerAccount(t, ctx, module, "expired@example.com", now)
		now = now.Add(24 * time.Hour)
		assertInvalidTokenLeavesPending(t, ctx, module, raw, now, "198.51.100.3")
	})

	t.Run("wrong purpose token", func(t *testing.T) {
		now := time.Date(2026, 8, 12, 11, 0, 0, 0, time.UTC)
		var raw string
		module := testModule(pool, &now, func(_ context.Context, _ string, token string) error { raw = token; return nil })
		registerAccount(t, ctx, module, "purpose@example.com", now)
		if _, err := pool.Exec(ctx, `UPDATE verification_tokens SET purpose='password_reset' WHERE account_id=(SELECT account_id FROM accounts WHERE email_normalized='purpose@example.com')`); err != nil {
			t.Fatal(err)
		}
		assertInvalidTokenLeavesPending(t, ctx, module, raw, now, "198.51.100.4")
	})

	t.Run("current generation consumes once", func(t *testing.T) {
		now := time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)
		var raw string
		module := testModule(pool, &now, func(_ context.Context, _ string, token string) error { raw = token; return nil })
		registerAccount(t, ctx, module, "current@example.com", now)
		result, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: raw, RequestTime: now, IP: "198.51.100.5", RequestID: "verify-current"})
		if err != nil || !result.Verified {
			t.Fatalf("verify = %+v, %v", result, err)
		}
		now = now.Add(time.Minute)
		if _, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: raw, RequestTime: now, IP: "198.51.100.5", RequestID: "verify-replay"}); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("replay error = %v", err)
		}
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM accounts WHERE email_normalized='current@example.com'`).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "active" {
			t.Fatalf("status = %q", status)
		}
	})
}

func TestConcurrentVerificationConsumesTokenOnce(t *testing.T) {
	ctx := context.Background()
	pool := newIdentityTestPool(t, ctx)
	now := time.Date(2026, 8, 12, 13, 0, 0, 0, time.UTC)
	var raw string
	register := testModule(pool, &now, func(_ context.Context, _ string, token string) error { raw = token; return nil })
	registerAccount(t, ctx, register, "consume@example.com", now)

	start := make(chan struct{})
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			module := testModule(pool, &now, func(context.Context, string, string) error { return nil })
			<-start
			_, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: raw, RequestTime: now, IP: fmt.Sprintf("203.0.113.%d", i+1), RequestID: fmt.Sprintf("concurrent-verify-%d", i)})
			errs <- err
		}(i)
	}
	close(start)
	var successes, invalid int
	for i := 0; i < 2; i++ {
		switch err := <-errs; {
		case err == nil:
			successes++
		case errors.Is(err, ErrInvalidToken):
			invalid++
		default:
			t.Fatalf("unexpected verify error: %v", err)
		}
	}
	if successes != 1 || invalid != 1 {
		t.Fatalf("success/invalid = %d/%d", successes, invalid)
	}
	var consumed int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM verification_tokens WHERE consumed_at IS NOT NULL`).Scan(&consumed); err != nil {
		t.Fatal(err)
	}
	if consumed != 1 {
		t.Fatalf("consumed rows = %d", consumed)
	}
}

func TestRegistrationAndResendRateLimitReturnSameErrorWithoutStateChange(t *testing.T) {
	ctx := context.Background()
	pool := newIdentityTestPool(t, ctx)
	now := time.Date(2026, 8, 12, 14, 0, 0, 0, time.UTC)
	module := testModule(pool, &now, func(context.Context, string, string) error { return nil })
	registerAccount(t, ctx, module, "existing@example.com", now)
	now = now.Add(time.Minute)
	module.limits.allow("identity:target:limited@example.com", now, 1, 5)
	_, registrationErr := module.Register(ctx, RegisterCommand{Email: "limited@example.com", Password: integrationPassword, IP: "192.0.2.1", RequestTime: now})
	if !errors.Is(registrationErr, ErrRateLimited) {
		t.Fatalf("rate-limited registration error = %v", registrationErr)
	}
	module.limits.allow("identity:target:existing@example.com", now, 1, 5)
	_, existingErr := module.ResendVerification(ctx, ResendVerificationCommand{Email: "existing@example.com", IP: "192.0.2.2", RequestTime: now})
	module.limits.allow("identity:target:missing@example.com", now, 1, 5)
	_, missingErr := module.ResendVerification(ctx, ResendVerificationCommand{Email: "missing@example.com", IP: "192.0.2.3", RequestTime: now})
	if !errors.Is(existingErr, ErrRateLimited) || !errors.Is(missingErr, ErrRateLimited) || existingErr.Error() != missingErr.Error() || existingErr.Error() != registrationErr.Error() {
		t.Fatalf("rate-limit errors registration/existing/missing = %v/%v/%v", registrationErr, existingErr, missingErr)
	}
	var accounts, tokens int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM accounts), (SELECT count(*) FROM verification_tokens)`).Scan(&accounts, &tokens); err != nil {
		t.Fatal(err)
	}
	if accounts != 1 || tokens != 1 {
		t.Fatalf("rate-limited accounts/tokens = %d/%d", accounts, tokens)
	}
}

func testModule(pool *pgxpool.Pool, now *time.Time, deliver func(context.Context, string, string) error) *Module {
	return &Module{
		pool: pool,
		now:  func() time.Time { return *now },
		randomBytes: func(dst []byte) (int, error) {
			randomCounter := byte(integrationRandomSeed.Add(1))
			for i := range dst {
				dst[i] = randomCounter + byte(i)
			}
			return len(dst), nil
		},
		hash:    func(string) (string, error) { return "$argon2id$test-only", nil },
		deliver: deliver,
		limits:  &limiter{},
	}
}

func registerAccount(t *testing.T, ctx context.Context, module *Module, email string, now time.Time) {
	t.Helper()
	result, err := module.Register(ctx, RegisterCommand{Email: email, Password: integrationPassword, RequestTime: now, IP: "198.51.100.200", RequestID: "register-" + email})
	if err != nil || !result.Accepted {
		t.Fatalf("register = %+v, %v", result, err)
	}
}

func assertInvalidTokenLeavesPending(t *testing.T, ctx context.Context, module *Module, raw string, now time.Time, ip string) {
	t.Helper()
	if _, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: raw, RequestTime: now, IP: ip, RequestID: "invalid-" + ip}); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("invalid token error = %v", err)
	}
	var active int
	if err := module.pool.QueryRow(ctx, `SELECT count(*) FROM accounts WHERE status='active'`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatalf("active accounts after invalid token = %d", active)
	}
}

func assertEventPayloadsExclude(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secrets ...string) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT payload::text FROM identity_security_events`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			t.Fatal(err)
		}
		for _, secret := range secrets {
			if secret != "" && strings.Contains(payload, secret) {
				t.Fatalf("event payload contains secret %q: %s", secret, payload)
			}
		}
		for _, forbidden := range []string{"password", "token", "digest", "session", `:\\`, "/home/", "/tmp/"} {
			if strings.Contains(strings.ToLower(payload), forbidden) {
				t.Fatalf("event payload contains forbidden field/value %q: %s", forbidden, payload)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func newIdentityTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TTSYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("TTSYNC_TEST_DATABASE_URL is required")
	}
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	schema := fmt.Sprintf("identity_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		adminPool.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := adminPool.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Errorf("drop schema: %v", err)
		}
		adminPool.Close()
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := postgres.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}
