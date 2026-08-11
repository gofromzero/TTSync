[CmdletBinding()]
param(
  [string]$BaseUrl = 'https://localhost:8443'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Get-ComposeContainer {
  param(
    [Parameter(Mandatory = $true)][string]$Service
  )
  $references = @(Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'ps', '-q', $Service) | Where-Object { $_ })
  if ($references.Count -ne 1) {
    throw "service $Service 必须且只能定位一个容器，实际为 $($references.Count)"
  }
  $inspection = @(Invoke-Native -Command docker -Arguments @('inspect', $references[0]) | ConvertFrom-Json)
  if ($inspection.Count -ne 1) {
    throw "service $Service 必须且只能 inspect 一个容器"
  }
  $container = $inspection[0]
  $expectedName = "$script:projectName-$Service-1"
  if ($container.Id -ne $references[0] -or
    $container.Name.TrimStart('/') -ne $expectedName -or
    $container.Config.Labels.'com.docker.compose.project' -ne $script:projectName -or
    $container.Config.Labels.'com.docker.compose.service' -ne $Service) {
    throw "拒绝使用 metadata 不匹配的 $Service 容器"
  }
  return $container
}

function Assert-HttpsStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][int]$ExpectedStatus
  )
  $savedBaseUrl = $env:B01_BASE_URL
  $savedExpectedStatus = $env:B01_EXPECT_NAVIGATION_STATUS
  try {
    $env:B01_BASE_URL = $Url
    $env:B01_EXPECT_NAVIGATION_STATUS = $ExpectedStatus.ToString()
    Invoke-Native -Command node -Arguments @('--test', 'test/b01-browser-smoke.mjs')
  }
  finally {
    $env:B01_BASE_URL = $savedBaseUrl
    $env:B01_EXPECT_NAVIGATION_STATUS = $savedExpectedStatus
  }
}

function Wait-PostgresHealthy {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $container = Get-ComposeContainer postgres
    if ($container.State.Health.Status -eq 'healthy') {
      return
    }
    if ($container.State.Health.Status -eq 'unhealthy' -or [DateTime]::UtcNow -ge $deadline) {
      throw "PostgreSQL 未恢复 healthy，当前状态为 $($container.State.Health.Status)"
    }
    Start-Sleep -Milliseconds 500
  } while ($true)
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$script:composeFile = Join-Path $repositoryRoot 'deployments/compose.yaml'
$baseUri = [Uri]$BaseUrl
if ($baseUri.Scheme -ne 'https') {
  throw "BaseUrl 必须使用 HTTPS：$BaseUrl"
}

$runId = ([Guid]::NewGuid().ToString('N')).Substring(0, 12)
$script:projectName = "ttsync-b01-$runId"
$previousPassword = $env:TTSYNC_POSTGRES_PASSWORD
$previousHttpsPort = $env:TTSYNC_HTTPS_PORT
$previousBaseUrl = $env:B01_BASE_URL
$previousExpectedNavigationStatus = $env:B01_EXPECT_NAVIGATION_STATUS
$previousRunBrowserSmoke = $env:B01_RUN_BROWSER_SMOKE
$env:TTSYNC_POSTGRES_PASSWORD = "TEST_ONLY_$runId"
$env:TTSYNC_HTTPS_PORT = $baseUri.Port.ToString()
$env:B01_BASE_URL = $BaseUrl.TrimEnd('/')
$env:B01_RUN_BROWSER_SMOKE = '1'
$databaseUrl = "postgres://ttsync:$($env:TTSYNC_POSTGRES_PASSWORD)@postgres:5432/ttsync?sslmode=disable"

Push-Location $repositoryRoot
try {
  $services = @(Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'config', '--services') | Sort-Object)
  if (($services -join ',') -ne 'app,caddy,postgres') {
    throw "Compose service 必须严格为 app,caddy,postgres，实际为 $($services -join ',')"
  }
  Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'config', '--quiet')
  Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'build')
  Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'up', '--detach', '--wait')

  $postgres = Get-ComposeContainer postgres
  $null = Get-ComposeContainer app
  $null = Get-ComposeContainer caddy

  Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'exec', '-T', 'app', '/app/migrate')
  Invoke-Native -Command docker -Arguments @(
    'compose', '-p', $script:projectName, '-f', $script:composeFile, 'exec', '-T',
    '-e', "TTSYNC_TEST_DATABASE_URL=$databaseUrl",
    '-e', 'TTSYNC_REQUIRE_DATABASE_STOP=0',
    'app', '/app/postgres-integration.test', '-test.v'
  )

  Invoke-Native -Command docker -Arguments @('stop', $postgres.Id) | Out-Null
  $readinessFailed = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      Assert-HttpsStatus "$($env:B01_BASE_URL)/health/ready" 503
      $readinessFailed = $true
      break
    }
    catch {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $readinessFailed) {
    throw '真实 PostgreSQL 停止后 HTTPS readiness 未返回 503'
  }
  Assert-HttpsStatus "$($env:B01_BASE_URL)/health/live" 200

  Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'start', 'postgres')
  Wait-PostgresHealthy
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      Assert-HttpsStatus "$($env:B01_BASE_URL)/health/ready" 200
      break
    }
    catch {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-HttpsStatus "$($env:B01_BASE_URL)/health/ready" 200

  $env:B01_EXPECT_NAVIGATION_STATUS = $null
  Invoke-Native -Command node -Arguments @('--test', 'test/b01-browser-smoke.mjs')
}
finally {
  try {
    Invoke-Native -Command docker -Arguments @('compose', '-p', $script:projectName, '-f', $script:composeFile, 'down', '-v', '--remove-orphans')
    $imageReference = "$script:projectName-app:latest"
    $imageIds = @(Invoke-Native -Command docker -Arguments @('images', '-q', '--no-trunc', $imageReference) | Where-Object { $_ })
    if ($imageIds.Count -gt 1) {
      throw "smoke cleanup 定位到多个 app image：$($imageIds.Count)"
    }
    if ($imageIds.Count -eq 1) {
      $imageInspection = @(Invoke-Native -Command docker -Arguments @('image', 'inspect', $imageReference) | ConvertFrom-Json)
      if ($imageInspection.Count -ne 1 -or
        $imageInspection[0].Id -ne $imageIds[0] -or
        $imageInspection[0].Config.Labels.'com.docker.compose.project' -ne $script:projectName -or
        $imageInspection[0].Config.Labels.'com.docker.compose.service' -ne 'app') {
        throw '拒绝删除 metadata 不匹配的 app image'
      }
      Invoke-Native -Command docker -Arguments @('image', 'rm', $imageReference) | Out-Null
    }
    $containers = @(Invoke-Native -Command docker -Arguments @('ps', '-aq', '--filter', "label=com.docker.compose.project=$script:projectName") | Where-Object { $_ })
    $volumes = @(Invoke-Native -Command docker -Arguments @('volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$script:projectName") | Where-Object { $_ })
    $networks = @(Invoke-Native -Command docker -Arguments @('network', 'ls', '-q', '--filter', "label=com.docker.compose.project=$script:projectName") | Where-Object { $_ })
    $images = @(Invoke-Native -Command docker -Arguments @('images', '-q', $imageReference) | Where-Object { $_ })
    if ($containers.Count -ne 0 -or $volumes.Count -ne 0 -or $networks.Count -ne 0 -or $images.Count -ne 0) {
      throw "smoke cleanup 留下资源：containers=$($containers.Count), volumes=$($volumes.Count), networks=$($networks.Count), images=$($images.Count)"
    }
  }
  finally {
    $env:TTSYNC_POSTGRES_PASSWORD = $previousPassword
    $env:TTSYNC_HTTPS_PORT = $previousHttpsPort
    $env:B01_BASE_URL = $previousBaseUrl
    $env:B01_EXPECT_NAVIGATION_STATUS = $previousExpectedNavigationStatus
    $env:B01_RUN_BROWSER_SMOKE = $previousRunBrowserSmoke
    Pop-Location
  }
}
