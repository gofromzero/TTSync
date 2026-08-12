//go:build integration

package identity

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	if accountCount != 1 || tokenCount != 1 || len(delivered) != 8 {
		t.Fatalf("accounts/tokens/deliveries = %d/%d/%d", accountCount, tokenCount, len(delivered))
	}
	var deliveredToken string
	for _, raw := range delivered {
		if raw != "" {
			if deliveredToken != "" {
				t.Fatalf("multiple real registration tokens delivered: %q and %q", deliveredToken, raw)
			}
			deliveredToken = raw
		}
	}
	if deliveredToken == "" {
		t.Fatal("real registration token was not delivered")
	}
	var digest []byte
	if err := pool.QueryRow(ctx, `SELECT token_digest FROM verification_tokens`).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if len(digest) != 32 {
		t.Fatalf("digest length = %d", len(digest))
	}
	assertEventPayloadsExclude(t, ctx, pool, integrationPassword, deliveredToken, hex.EncodeToString(digest))
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

func TestVerifyWaitsForAccountBeforeLockingToken(t *testing.T) {
	ctx := context.Background()
	pool := newIdentityTestPool(t, ctx)
	now := time.Date(2026, 8, 12, 13, 30, 0, 0, time.UTC)
	var raw string
	module := testModule(pool, &now, func(_ context.Context, _ string, token string) error { raw = token; return nil })
	registerAccount(t, ctx, module, "lock-order@example.com", now)

	accountLock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer accountLock.Rollback(ctx)
	if _, err := accountLock.Exec(ctx, `SELECT account_id FROM accounts WHERE email_normalized='lock-order@example.com' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	verifyDone := make(chan error, 1)
	go func() {
		_, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: raw, RequestTime: now, IP: "203.0.113.30", RequestID: "lock-order"})
		verifyDone <- err
	}()
	waitForLockWait(t, ctx, pool)

	probe, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(mustDecodeToken(t, raw))
	if _, err := probe.Exec(ctx, `SELECT token_id FROM verification_tokens WHERE token_digest=$1 FOR UPDATE NOWAIT`, digest[:]); err != nil {
		probe.Rollback(ctx)
		t.Fatalf("verify locked token before account: %v", err)
	}
	if err := probe.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := accountLock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-verifyDone; err != nil {
		t.Fatalf("verify after account release: %v", err)
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

func TestDeliveryFailureDoesNotRevealRegistrationOrResendState(t *testing.T) {
	deliveryErr := errors.New("verification delivery unavailable")

	t.Run("new and duplicate registration", func(t *testing.T) {
		ctx := context.Background()
		pool := newIdentityTestPool(t, ctx)
		now := time.Date(2026, 8, 12, 15, 0, 0, 0, time.UTC)
		var raws []string
		module := testModule(pool, &now, func(_ context.Context, _ string, raw string) error {
			raws = append(raws, raw)
			return deliveryErr
		})
		_, newErr := module.Register(ctx, RegisterCommand{Email: "delivery@example.com", Password: integrationPassword, IP: "192.0.2.10", RequestTime: now, RequestID: "delivery-new"})
		now = now.Add(time.Minute)
		_, duplicateErr := module.Register(ctx, RegisterCommand{Email: "delivery@example.com", Password: integrationPassword, IP: "192.0.2.11", RequestTime: now, RequestID: "delivery-duplicate"})
		if !errors.Is(newErr, deliveryErr) || !errors.Is(duplicateErr, deliveryErr) {
			t.Fatalf("new/duplicate delivery errors = %v/%v", newErr, duplicateErr)
		}
		if len(raws) != 2 || raws[0] == "" || raws[1] != "" {
			t.Fatalf("new/duplicate delivered raw tokens = %#v", raws)
		}
		var accounts, tokens int
		if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM accounts), (SELECT count(*) FROM verification_tokens)`).Scan(&accounts, &tokens); err != nil {
			t.Fatal(err)
		}
		if accounts != 1 || tokens != 1 {
			t.Fatalf("new/duplicate accounts/tokens = %d/%d", accounts, tokens)
		}
	})

	t.Run("pending nonexistent and active resend", func(t *testing.T) {
		ctx := context.Background()
		pool := newIdentityTestPool(t, ctx)
		now := time.Date(2026, 8, 12, 16, 0, 0, 0, time.UTC)
		var activeRaw string
		module := testModule(pool, &now, func(_ context.Context, email, raw string) error {
			if email == "active-delivery@example.com" {
				activeRaw = raw
			}
			return nil
		})
		registerAccount(t, ctx, module, "pending-delivery@example.com", now)
		registerAccount(t, ctx, module, "active-delivery@example.com", now)
		if _, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: activeRaw, RequestTime: now, IP: "192.0.2.20", RequestID: "activate-delivery"}); err != nil {
			t.Fatal(err)
		}

		now = now.Add(time.Minute)
		var raws []string
		module.deliver = func(_ context.Context, _ string, raw string) error {
			raws = append(raws, raw)
			return deliveryErr
		}
		_, pendingErr := module.ResendVerification(ctx, ResendVerificationCommand{Email: "pending-delivery@example.com", RequestTime: now, IP: "192.0.2.21", RequestID: "resend-pending"})
		_, missingErr := module.ResendVerification(ctx, ResendVerificationCommand{Email: "missing-delivery@example.com", RequestTime: now, IP: "192.0.2.22", RequestID: "resend-missing"})
		_, activeErr := module.ResendVerification(ctx, ResendVerificationCommand{Email: "active-delivery@example.com", RequestTime: now, IP: "192.0.2.23", RequestID: "resend-active"})
		if !errors.Is(pendingErr, deliveryErr) || !errors.Is(missingErr, deliveryErr) || !errors.Is(activeErr, deliveryErr) {
			t.Fatalf("pending/missing/active delivery errors = %v/%v/%v", pendingErr, missingErr, activeErr)
		}
		if len(raws) != 3 || raws[0] == "" || raws[1] != "" || raws[2] != "" {
			t.Fatalf("pending/missing/active delivered raw tokens = %#v", raws)
		}
		var pendingStatus, activeStatus string
		var pendingTokens, missingAccounts, activeTokens int
		if err := pool.QueryRow(ctx, `SELECT status FROM accounts WHERE email_normalized='pending-delivery@example.com'`).Scan(&pendingStatus); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT status FROM accounts WHERE email_normalized='active-delivery@example.com'`).Scan(&activeStatus); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM verification_tokens WHERE account_id=(SELECT account_id FROM accounts WHERE email_normalized='pending-delivery@example.com')),
			(SELECT count(*) FROM accounts WHERE email_normalized='missing-delivery@example.com'),
			(SELECT count(*) FROM verification_tokens WHERE account_id=(SELECT account_id FROM accounts WHERE email_normalized='active-delivery@example.com'))`).Scan(&pendingTokens, &missingAccounts, &activeTokens); err != nil {
			t.Fatal(err)
		}
		if pendingStatus != "pending_verification" || activeStatus != "active" || pendingTokens != 2 || missingAccounts != 0 || activeTokens != 1 {
			t.Fatalf("states pending/active/pendingTokens/missing/activeTokens = %s/%s/%d/%d/%d", pendingStatus, activeStatus, pendingTokens, missingAccounts, activeTokens)
		}
	})
}

func TestRefusalEventPersistenceErrorsArePropagated(t *testing.T) {
	tests := []struct {
		name string
		run  func(*testing.T, context.Context, *pgxpool.Pool, *Module, *time.Time) error
	}{
		{"registration rate limit", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			module.identityRateLimited("event-register@example.com", "192.0.2.40", *now)
			_, err := module.Register(ctx, RegisterCommand{Email: "event-register@example.com", Password: integrationPassword, IP: "192.0.2.40", RequestTime: *now})
			return err
		}},
		{"duplicate registration", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			registerAccount(t, ctx, module, "event-duplicate@example.com", *now)
			installFailingEventTrigger(t, ctx, module.pool)
			*now = now.Add(time.Minute)
			_, err := module.Register(ctx, RegisterCommand{Email: "event-duplicate@example.com", Password: integrationPassword, IP: "192.0.2.41", RequestTime: *now})
			return err
		}},
		{"resend rate limit", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			module.identityRateLimited("event-resend@example.com", "192.0.2.42", *now)
			_, err := module.ResendVerification(ctx, ResendVerificationCommand{Email: "event-resend@example.com", IP: "192.0.2.42", RequestTime: *now})
			return err
		}},
		{"nonexistent resend", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			_, err := module.ResendVerification(ctx, ResendVerificationCommand{Email: "event-missing@example.com", IP: "192.0.2.43", RequestTime: *now})
			return err
		}},
		{"verification rate limit", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			module.verificationRateLimited("event-rate-token", "192.0.2.44", *now)
			_, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: "event-rate-token", IP: "192.0.2.44", RequestTime: *now})
			return err
		}},
		{"malformed verification token", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			_, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: "bad", IP: "192.0.2.45", RequestTime: *now})
			return err
		}},
		{"unknown verification token", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			unknown := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
			_, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: unknown, IP: "192.0.2.46", RequestTime: *now})
			return err
		}},
		{"invalid verification token state", func(t *testing.T, ctx context.Context, _ *pgxpool.Pool, module *Module, now *time.Time) error {
			var raw string
			module.deliver = func(_ context.Context, _ string, token string) error { raw = token; return nil }
			registerAccount(t, ctx, module, "event-expired@example.com", *now)
			installFailingEventTrigger(t, ctx, module.pool)
			*now = now.Add(24 * time.Hour)
			_, err := module.VerifyEmail(ctx, VerifyEmailCommand{Token: raw, IP: "192.0.2.47", RequestTime: *now})
			return err
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			pool := newIdentityTestPool(t, ctx)
			now := time.Date(2026, 8, 12, 17, 0, 0, 0, time.UTC)
			module := testModule(pool, &now, func(context.Context, string, string) error { return nil })
			if test.name != "duplicate registration" && test.name != "invalid verification token state" {
				installFailingEventTrigger(t, ctx, pool)
			}
			err := test.run(t, ctx, pool, module, &now)
			if err == nil || !strings.Contains(err.Error(), "forced identity event failure") {
				t.Fatalf("refusal error = %v", err)
			}
		})
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

func mustDecodeToken(t *testing.T, raw string) []byte {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func waitForLockWait(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event_type='Lock'
			AND (query LIKE '%verification_tokens%' OR query LIKE '%accounts%')
		)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("verify did not reach a database lock wait")
}

func installFailingEventTrigger(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION reject_identity_event() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			RAISE EXCEPTION 'forced identity event failure';
		END
		$$;
		CREATE TRIGGER reject_identity_event BEFORE INSERT ON identity_security_events
		FOR EACH ROW EXECUTE FUNCTION reject_identity_event();
	`); err != nil {
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
