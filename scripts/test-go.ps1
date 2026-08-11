$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$createdContainerId = $null
$runId = ([Guid]::NewGuid().ToString('N')).Substring(0, 12)
$containerName = "ttsync-b01-task3-$runId"
$previousTestDatabaseUrl = $env:TTSYNC_TEST_DATABASE_URL

Push-Location $repositoryRoot
try {
    Invoke-Native powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-sqlc.ps1
    Invoke-Native go test ./... -count=1

    if ([string]::IsNullOrWhiteSpace($env:TTSYNC_TEST_DATABASE_URL)) {
        $testPassword = "TEST_ONLY_$([Guid]::NewGuid().ToString('N'))"
        $createdContainerId = (& docker run --detach --name $containerName `
            --label 'ttsync.task=issue-30-task3' `
            --label "ttsync.run=$runId" `
            --env "POSTGRES_PASSWORD=$testPassword" `
            --env 'POSTGRES_USER=ttsync_test' `
            --env 'POSTGRES_DB=ttsync_test' `
            --publish '127.0.0.1::5432' `
            --health-cmd 'pg_isready -U ttsync_test -d ttsync_test' `
            --health-interval 1s `
            --health-timeout 3s `
            --health-retries 30 `
            postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($createdContainerId)) {
            throw 'failed to start disposable PostgreSQL container'
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            $inspectionJson = & docker inspect $createdContainerId
            if ($LASTEXITCODE -ne 0) {
                throw 'failed to inspect disposable PostgreSQL health'
            }
            $inspection = @($inspectionJson | ConvertFrom-Json)
            if ($inspection.Count -ne 1) {
                throw 'expected exactly one disposable PostgreSQL container'
            }
            $health = [string]$inspection[0].State.Health.Status
            if ($health -eq 'healthy') {
                break
            }
            if ($health -eq 'unhealthy' -or [DateTime]::UtcNow -ge $deadline) {
                throw "disposable PostgreSQL did not become healthy (status: $health)"
            }
            Start-Sleep -Milliseconds 250
        } while ($true)

        $portBindings = @($inspection[0].NetworkSettings.Ports.'5432/tcp')
        if ($portBindings.Count -ne 1 -or $portBindings[0].HostIp -ne '127.0.0.1') {
            throw 'disposable PostgreSQL must expose one loopback-only port'
        }
        $hostPort = [string]$portBindings[0].HostPort
        if ($hostPort -notmatch '^\d+$') {
            throw 'failed to resolve disposable PostgreSQL loopback port'
        }
        $escapedPassword = [Uri]::EscapeDataString($testPassword)
        $env:TTSYNC_TEST_DATABASE_URL = "postgres://ttsync_test:$escapedPassword@127.0.0.1:$hostPort/ttsync_test?sslmode=disable"
    }

    Invoke-Native go test -tags=integration ./... -count=1
}
finally {
    $env:TTSYNC_TEST_DATABASE_URL = $previousTestDatabaseUrl
    if (-not [string]::IsNullOrWhiteSpace($createdContainerId)) {
        $cleanupJson = & docker inspect $createdContainerId
        if ($LASTEXITCODE -ne 0) {
            throw 'failed to inspect disposable PostgreSQL before cleanup'
        }
        $cleanupInspection = @($cleanupJson | ConvertFrom-Json)
        if ($cleanupInspection.Count -ne 1) {
            throw 'expected exactly one disposable PostgreSQL container during cleanup'
        }
        $cleanupContainer = $cleanupInspection[0]
        if ($cleanupContainer.Id -ne $createdContainerId -or $cleanupContainer.Name.TrimStart('/') -ne $containerName -or $cleanupContainer.Config.Labels.'ttsync.task' -ne 'issue-30-task3' -or $cleanupContainer.Config.Labels.'ttsync.run' -ne $runId) {
            throw 'refusing to remove untrusted PostgreSQL container metadata'
        }
        & docker rm --force $createdContainerId | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'failed to remove disposable PostgreSQL container'
        }
    }
    Pop-Location
}
