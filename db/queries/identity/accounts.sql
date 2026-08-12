-- name: CreateAccount :one
INSERT INTO accounts (email_display, email_normalized, password_hash, status, created_at, updated_at)
VALUES ($1, $2, $3, 'pending_verification', $4, $4)
ON CONFLICT (email_normalized) DO NOTHING
RETURNING account_id;

-- name: FindAccountByEmailForUpdate :one
SELECT account_id, email_display, status
FROM accounts
WHERE email_normalized = $1
FOR UPDATE;

-- name: InsertVerificationToken :exec
INSERT INTO verification_tokens (account_id, purpose, generation, token_digest, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: RevokeVerificationTokens :exec
UPDATE verification_tokens
SET revoked_at = $3
WHERE account_id = $1 AND purpose = $2 AND consumed_at IS NULL AND revoked_at IS NULL;

-- name: NextVerificationGeneration :one
SELECT COALESCE(MAX(generation), 0)::bigint + 1
FROM verification_tokens
WHERE account_id = $1 AND purpose = $2;

-- name: FindVerificationTokenForUpdate :one
SELECT token_id, account_id, purpose, generation, expires_at, consumed_at, revoked_at
FROM verification_tokens
WHERE token_digest = $1
FOR UPDATE;

-- name: CurrentVerificationGeneration :one
SELECT COALESCE(MAX(generation), 0)::bigint
FROM verification_tokens
WHERE account_id = $1 AND purpose = $2;

-- name: ConsumeVerificationToken :execrows
UPDATE verification_tokens
SET consumed_at = $2
WHERE token_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL;

-- name: ActivateAccount :execrows
UPDATE accounts
SET status = 'active', updated_at = $2
WHERE account_id = $1 AND status = 'pending_verification';

-- name: InsertIdentitySecurityEvent :exec
INSERT INTO identity_security_events (account_id, event_type, occurred_at, payload)
VALUES ($1, $2, $3, $4);
