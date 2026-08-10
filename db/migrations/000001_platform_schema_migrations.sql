CREATE TABLE schema_migrations (
    version bigint PRIMARY KEY CHECK (version > 0),
    checksum character(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
