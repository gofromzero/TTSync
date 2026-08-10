package migrations

import "embed"

// Files contains the immutable forward-only PostgreSQL migrations.
//
//go:embed *.sql
var Files embed.FS
