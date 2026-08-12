CREATE TABLE accounts (
    account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email_display character varying(254) NOT NULL,
    email_normalized character varying(254) NOT NULL UNIQUE,
    password_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending_verification', 'active')),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE verification_tokens (
    token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(account_id),
    purpose text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    UNIQUE (account_id, purpose, generation)
);

CREATE TABLE identity_security_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid REFERENCES accounts(account_id),
    event_type text NOT NULL CHECK (event_type IN (
        'registration_created', 'registration_refused',
        'verification_resent', 'resend_refused',
        'email_verified', 'verification_refused'
    )),
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload - ARRAY['requestId', 'ip', 'reason']::text[] = '{}'::jsonb
    )
);
