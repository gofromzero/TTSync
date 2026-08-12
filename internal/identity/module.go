package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	identitysqlc "github.com/gofromzero/ttsync/internal/identity/sqlc"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const verificationPurpose = "email_verification"

var (
	ErrInvalidToken = errors.New("invalid verification token")
	ErrRateLimited  = errors.New("rate limited")
	packageLimiter  limiter
)

type RegisterCommand struct {
	Email, Password, IP, RequestID string
	RequestTime                    time.Time
}

type ResendVerificationCommand struct {
	Email, IP, RequestID string
	RequestTime          time.Time
}

type VerifyEmailCommand struct {
	Token, IP, RequestID string
	RequestTime          time.Time
}

type AcceptedResult struct{ Accepted bool }
type VerifiedResult struct{ Verified bool }

type Module struct {
	pool        *pgxpool.Pool
	now         func() time.Time
	randomBytes func([]byte) (int, error)
	hash        func(string) (string, error)
	deliver     func(context.Context, string, string) error
	limits      *limiter
}

func New(pool *pgxpool.Pool, deliver func(context.Context, string, string) error) *Module {
	m := &Module{pool: pool, now: time.Now, randomBytes: rand.Read, deliver: deliver, limits: &packageLimiter}
	m.hash = func(password string) (string, error) { return hashPassword(password, m.randomBytes) }
	return m
}

func (m *Module) Register(ctx context.Context, command RegisterCommand) (AcceptedResult, error) {
	display, key, err := normalizeEmail(command.Email)
	if err != nil {
		return AcceptedResult{}, err
	}
	if err := validatePassword(command.Password); err != nil {
		return AcceptedResult{}, err
	}
	now := m.requestTime(command.RequestTime)
	if m.identityRateLimited(key, command.IP, now) {
		if err := m.refusalEvent(ctx, "registration_refused", now, command.RequestID, command.IP, "rate_limited"); err != nil {
			return AcceptedResult{}, err
		}
		return AcceptedResult{}, ErrRateLimited
	}
	passwordHash, err := m.hash(command.Password)
	if err != nil {
		return AcceptedResult{}, fmt.Errorf("hash password: %w", err)
	}
	token, err := newVerificationToken(now, m.randomBytes)
	if err != nil {
		return AcceptedResult{}, err
	}
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return AcceptedResult{}, fmt.Errorf("begin registration: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := identitysqlc.New(tx)
	accountID, err := queries.CreateAccount(ctx, identitysqlc.CreateAccountParams{
		EmailDisplay: display, EmailNormalized: key, PasswordHash: passwordHash, CreatedAt: dbTime(now),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		if err := m.refusalEvent(ctx, "registration_refused", now, command.RequestID, command.IP, "duplicate"); err != nil {
			return AcceptedResult{}, err
		}
		if m.deliver != nil {
			if err := m.deliver(ctx, display, ""); err != nil {
				return AcceptedResult{}, fmt.Errorf("deliver verification: %w", err)
			}
		}
		return AcceptedResult{Accepted: true}, nil
	}
	if err != nil {
		return AcceptedResult{}, fmt.Errorf("create account: %w", err)
	}
	if err := insertToken(ctx, queries, accountID, 1, token, now); err != nil {
		return AcceptedResult{}, err
	}
	if err := insertEvent(ctx, queries, accountID, "registration_created", now, command.RequestID, command.IP, ""); err != nil {
		return AcceptedResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptedResult{}, fmt.Errorf("commit registration: %w", err)
	}
	if m.deliver != nil {
		if err := m.deliver(ctx, display, token.raw); err != nil {
			return AcceptedResult{}, fmt.Errorf("deliver verification: %w", err)
		}
	}
	return AcceptedResult{Accepted: true}, nil
}

func (m *Module) ResendVerification(ctx context.Context, command ResendVerificationCommand) (AcceptedResult, error) {
	display, key, err := normalizeEmail(command.Email)
	if err != nil {
		return AcceptedResult{}, err
	}
	now := m.requestTime(command.RequestTime)
	if m.identityRateLimited(key, command.IP, now) {
		if err := m.refusalEvent(ctx, "resend_refused", now, command.RequestID, command.IP, "rate_limited"); err != nil {
			return AcceptedResult{}, err
		}
		return AcceptedResult{}, ErrRateLimited
	}
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return AcceptedResult{}, fmt.Errorf("begin resend: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := identitysqlc.New(tx)
	account, err := queries.FindAccountByEmailForUpdate(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && account.Status != "pending_verification" {
		_ = tx.Rollback(ctx)
		if err := m.refusalEvent(ctx, "resend_refused", now, command.RequestID, command.IP, "not_pending"); err != nil {
			return AcceptedResult{}, err
		}
		if m.deliver != nil {
			if err := m.deliver(ctx, display, ""); err != nil {
				return AcceptedResult{}, fmt.Errorf("deliver verification: %w", err)
			}
		}
		return AcceptedResult{Accepted: true}, nil
	}
	if err != nil {
		return AcceptedResult{}, fmt.Errorf("find resend account: %w", err)
	}
	token, err := newVerificationToken(now, m.randomBytes)
	if err != nil {
		return AcceptedResult{}, err
	}
	generation, err := queries.NextVerificationGeneration(ctx, identitysqlc.NextVerificationGenerationParams{AccountID: account.AccountID, Purpose: verificationPurpose})
	if err != nil {
		return AcceptedResult{}, fmt.Errorf("next verification generation: %w", err)
	}
	if err := queries.RevokeVerificationTokens(ctx, identitysqlc.RevokeVerificationTokensParams{AccountID: account.AccountID, Purpose: verificationPurpose, RevokedAt: dbTime(now)}); err != nil {
		return AcceptedResult{}, fmt.Errorf("revoke verification tokens: %w", err)
	}
	if err := insertToken(ctx, queries, account.AccountID, int64(generation), token, now); err != nil {
		return AcceptedResult{}, err
	}
	if err := insertEvent(ctx, queries, account.AccountID, "verification_resent", now, command.RequestID, command.IP, ""); err != nil {
		return AcceptedResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptedResult{}, fmt.Errorf("commit resend: %w", err)
	}
	if m.deliver != nil {
		if err := m.deliver(ctx, account.EmailDisplay, token.raw); err != nil {
			return AcceptedResult{}, fmt.Errorf("deliver verification: %w", err)
		}
	}
	return AcceptedResult{Accepted: true}, nil
}

func (m *Module) VerifyEmail(ctx context.Context, command VerifyEmailCommand) (VerifiedResult, error) {
	now := m.requestTime(command.RequestTime)
	if m.verificationRateLimited(command.Token, command.IP, now) {
		if err := m.refusalEvent(ctx, "verification_refused", now, command.RequestID, command.IP, "rate_limited"); err != nil {
			return VerifiedResult{}, err
		}
		return VerifiedResult{}, ErrRateLimited
	}
	raw, err := base64.RawURLEncoding.DecodeString(command.Token)
	if err != nil || len(raw) < 16 {
		if err := m.refusalEvent(ctx, "verification_refused", now, command.RequestID, command.IP, "invalid"); err != nil {
			return VerifiedResult{}, err
		}
		return VerifiedResult{}, ErrInvalidToken
	}
	digest := sha256.Sum256(raw)
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return VerifiedResult{}, fmt.Errorf("begin verification: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := identitysqlc.New(tx)
	if _, err := queries.LockVerificationAccountByDigest(ctx, digest[:]); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			if err := m.refusalEvent(ctx, "verification_refused", now, command.RequestID, command.IP, "invalid"); err != nil {
				return VerifiedResult{}, err
			}
			return VerifiedResult{}, ErrInvalidToken
		}
		return VerifiedResult{}, fmt.Errorf("lock verification account: %w", err)
	}
	token, err := queries.FindVerificationTokenForUpdate(ctx, digest[:])
	if err != nil {
		return VerifiedResult{}, fmt.Errorf("find verification token: %w", err)
	}
	current, err := queries.CurrentVerificationGeneration(ctx, identitysqlc.CurrentVerificationGenerationParams{AccountID: token.AccountID, Purpose: verificationPurpose})
	if err != nil {
		return VerifiedResult{}, fmt.Errorf("read verification generation: %w", err)
	}
	if token.Purpose != verificationPurpose || token.Generation != current || !token.ExpiresAt.Valid || !token.ExpiresAt.Time.After(now) || token.ConsumedAt.Valid || token.RevokedAt.Valid {
		_ = tx.Rollback(ctx)
		if err := m.refusalEvent(ctx, "verification_refused", now, command.RequestID, command.IP, "invalid"); err != nil {
			return VerifiedResult{}, err
		}
		return VerifiedResult{}, ErrInvalidToken
	}
	changed, err := queries.ConsumeVerificationToken(ctx, identitysqlc.ConsumeVerificationTokenParams{TokenID: token.TokenID, ConsumedAt: dbTime(now)})
	if err != nil || changed != 1 {
		return VerifiedResult{}, fmt.Errorf("consume verification token: rows=%d: %w", changed, err)
	}
	if _, err := queries.ActivateAccount(ctx, identitysqlc.ActivateAccountParams{AccountID: token.AccountID, UpdatedAt: dbTime(now)}); err != nil {
		return VerifiedResult{}, fmt.Errorf("activate account: %w", err)
	}
	if err := insertEvent(ctx, queries, token.AccountID, "email_verified", now, command.RequestID, command.IP, ""); err != nil {
		return VerifiedResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VerifiedResult{}, fmt.Errorf("commit verification: %w", err)
	}
	return VerifiedResult{Verified: true}, nil
}

func (m *Module) identityRateLimited(target, ip string, now time.Time) bool {
	targetAllowed := m.limits.allow("identity:target:"+target, now, 1, 5)
	ipAllowed := m.limits.allow("identity:ip:"+ip, now, 20, 20)
	return !targetAllowed || !ipAllowed
}

func (m *Module) verificationRateLimited(rawToken, ip string, now time.Time) bool {
	target := sha256.Sum256([]byte(rawToken))
	targetAllowed := m.limits.allow("verification:target:"+string(target[:]), now, 1, 5)
	ipAllowed := m.limits.allow("verification:ip:"+ip, now, 30, 30)
	return !targetAllowed || !ipAllowed
}

func (m *Module) requestTime(commandTime time.Time) time.Time {
	if !commandTime.IsZero() {
		return commandTime
	}
	return m.now()
}

func (m *Module) refusalEvent(ctx context.Context, eventType string, at time.Time, requestID, ip, reason string) error {
	return insertEvent(ctx, identitysqlc.New(m.pool), pgtype.UUID{}, eventType, at, requestID, ip, reason)
}

func insertToken(ctx context.Context, queries *identitysqlc.Queries, accountID pgtype.UUID, generation int64, token verificationToken, now time.Time) error {
	if err := queries.InsertVerificationToken(ctx, identitysqlc.InsertVerificationTokenParams{
		AccountID: accountID, Purpose: verificationPurpose, Generation: generation, TokenDigest: token.digest[:], ExpiresAt: dbTime(token.expiresAt), CreatedAt: dbTime(now),
	}); err != nil {
		return fmt.Errorf("insert verification token: %w", err)
	}
	return nil
}

func insertEvent(ctx context.Context, queries *identitysqlc.Queries, accountID pgtype.UUID, eventType string, at time.Time, requestID, ip, reason string) error {
	payload := map[string]string{"requestId": requestID, "ip": ip}
	if reason != "" {
		payload["reason"] = reason
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode identity event: %w", err)
	}
	if err := queries.InsertIdentitySecurityEvent(ctx, identitysqlc.InsertIdentitySecurityEventParams{AccountID: accountID, EventType: eventType, OccurredAt: dbTime(at), Payload: encoded}); err != nil {
		return fmt.Errorf("insert identity event: %w", err)
	}
	return nil
}

func dbTime(value time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: value, Valid: true} }
