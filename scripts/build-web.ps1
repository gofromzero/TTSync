param(
    [switch]$TypecheckOnly
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webDirectory = Join-Path $repositoryRoot 'clients/web'

Push-Location $webDirectory
try {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE"
    }

    if ($TypecheckOnly) {
        npm.cmd run typecheck
    }
    else {
        npm.cmd run build
    }
    if ($LASTEXITCODE -ne 0) {
        throw "web command failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
