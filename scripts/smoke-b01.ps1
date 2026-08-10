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

  $postgresContainerRefs = @(docker compose -f $composeFile ps -q postgres | Where-Object { $_ })
  if ($postgresContainerRefs.Count -ne 1) {
    throw "必须且只能定位一个 PostgreSQL 容器，实际为 $($postgresContainerRefs.Count)"
  }
  $postgresContainerId = docker inspect --format '{{.Id}}' $postgresContainerRefs[0]
  $composeProject = docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' $postgresContainerId
  if ([string]::IsNullOrWhiteSpace($postgresContainerId) -or [string]::IsNullOrWhiteSpace($composeProject)) {
    throw '无法取得 PostgreSQL 容器 ID 或 Compose project label'
  }

  docker compose -f $composeFile exec -T app /app/migrate
  docker compose -f $composeFile exec -T `
    -e "TTSYNC_TEST_DATABASE_URL=$env:TTSYNC_TEST_DATABASE_URL" `
    -e "TTSYNC_TEST_POSTGRES_CONTAINER=$postgresContainerId" `
    -e "TTSYNC_TEST_COMPOSE_PROJECT=$composeProject" `
    app go test -tags=integration ./internal/platform/postgres -count=1
  if ($LASTEXITCODE -ne 0) {
    throw 'PostgreSQL integration test 失败'
  }

  docker compose -f $composeFile up --detach postgres
  if ($LASTEXITCODE -ne 0) {
    throw 'PostgreSQL 停库测试后恢复失败'
  }
  $postgresHealthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $currentPostgres = docker compose -f $composeFile ps -q postgres
    if (-not [string]::IsNullOrWhiteSpace($currentPostgres)) {
      $postgresHealth = docker inspect --format '{{.State.Health.Status}}' $currentPostgres
      if ($postgresHealth -eq 'healthy') {
        $postgresHealthy = $true
        break
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $postgresHealthy) {
    throw 'PostgreSQL 在停库测试后未恢复 healthy'
  }

  node --test test/b01-browser-smoke.mjs
} finally {
  docker compose -f $composeFile down -v --remove-orphans
  Pop-Location
}
