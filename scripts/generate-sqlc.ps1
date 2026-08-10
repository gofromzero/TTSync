$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repositoryRoot
try {
    & go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f db/sqlc.yaml
    if ($LASTEXITCODE -ne 0) {
        throw "sqlc v1.31.1 generation failed with exit code $LASTEXITCODE"
    }

    & git diff --exit-code -- internal/platform/postgres/sqlc
    if ($LASTEXITCODE -ne 0) {
        throw 'sqlc generated output drifted; run npm run db:generate and commit the result'
    }
}
finally {
    Pop-Location
}
