[CmdletBinding()]
param(
  [string]$BaseUrl = 'https://localhost:8443'
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repositoryRoot 'deployments/compose.yaml'
$baseUri = [Uri]$BaseUrl

if ($baseUri.Scheme -ne 'https') {
  throw "BaseUrl 必须使用 HTTPS：$BaseUrl"
}

$env:TTSYNC_POSTGRES_PASSWORD = 'TEST_ONLY'
$env:TTSYNC_HTTPS_PORT = $baseUri.Port.ToString()
$env:TTSYNC_TEST_DATABASE_URL = 'postgres://ttsync:TEST_ONLY@postgres:5432/ttsync?sslmode=disable'
$env:B01_BASE_URL = $BaseUrl

Push-Location $repositoryRoot
try {
  docker compose -f $composeFile config --services
  docker compose -f $composeFile build
  docker compose -f $composeFile up --detach --wait

  docker compose -f $composeFile exec -T app /app/migrate
  docker compose -f $composeFile exec -T -e "TTSYNC_TEST_DATABASE_URL=$env:TTSYNC_TEST_DATABASE_URL" app go test -tags=integration ./internal/platform/postgres -count=1
  node --test test/b01-browser-smoke.mjs
} finally {
  docker compose -f $composeFile down -v --remove-orphans
  Pop-Location
}
