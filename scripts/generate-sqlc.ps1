param(
    [string]$SqlcArchivePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$assetName = 'sqlc_1.31.1_windows_amd64.zip'
$assetUrl = "https://github.com/sqlc-dev/sqlc/releases/download/v1.31.1/$assetName"
$expectedSha256 = '352711fa7dcb05dcdfefca0ad71b2c9a74fd090f8d7fc609419de4cbc725429f'
$runId = [Guid]::NewGuid().ToString('N')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot "ttsync-sqlc-$runId"))
$archivePath = Join-Path $tempDirectory $assetName
$extractPath = Join-Path $tempDirectory 'extracted'
$locationPushed = $false

try {
    New-Item -ItemType Directory -Path $tempDirectory | Out-Null
    if ([string]::IsNullOrWhiteSpace($SqlcArchivePath)) {
        Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $archivePath
    }
    else {
        if (-not (Test-Path -LiteralPath $SqlcArchivePath -PathType Leaf)) {
            throw "sqlc archive does not exist: $SqlcArchivePath"
        }
        Copy-Item -LiteralPath $SqlcArchivePath -Destination $archivePath
    }

    $archiveStream = [IO.File]::OpenRead($archivePath)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $sha256.ComputeHash($archiveStream)
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $archiveStream.Dispose()
    }
    $actualSha256 = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "sqlc v1.31.1 archive checksum mismatch: expected $expectedSha256, got $actualSha256"
    }

    New-Item -ItemType Directory -Path $extractPath | Out-Null
    [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractPath)
    $sqlcExecutable = Join-Path $extractPath 'sqlc.exe'
    if (-not (Test-Path -LiteralPath $sqlcExecutable -PathType Leaf)) {
        throw 'verified sqlc v1.31.1 archive does not contain sqlc.exe'
    }

    Push-Location $repositoryRoot
    $locationPushed = $true
    & $sqlcExecutable generate -f db/sqlc.yaml
    if ($LASTEXITCODE -ne 0) {
        throw "sqlc v1.31.1 generation failed with exit code $LASTEXITCODE"
    }

    & git diff --exit-code -- internal/platform/postgres/sqlc
    if ($LASTEXITCODE -ne 0) {
        throw 'sqlc generated output drifted; run npm run db:generate and commit the result'
    }
}
finally {
    if ($locationPushed) {
        Pop-Location
    }
    if (Test-Path -LiteralPath $tempDirectory) {
        $expectedLeaf = "ttsync-sqlc-$runId"
        $rootPrefix = $tempRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if ((Split-Path -Leaf $tempDirectory) -ne $expectedLeaf -or -not $tempDirectory.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "refusing to remove unexpected sqlc temporary directory: $tempDirectory"
        }
        Remove-Item -LiteralPath $tempDirectory -Recurse -Force
    }
}
