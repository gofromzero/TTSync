param(
    [Parameter(Mandatory = $true)][string]$ExpectedDirectory,
    [Parameter(Mandatory = $true)][string]$ActualDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$expectedRoot = [IO.Path]::GetFullPath($ExpectedDirectory)
$actualRoot = [IO.Path]::GetFullPath($ActualDirectory)
foreach ($directory in @($expectedRoot, $actualRoot)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "generated directory does not exist: $directory"
    }
}

function Get-RelativeFiles {
    param([Parameter(Mandatory = $true)][string]$Root)
    $prefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
        $_.FullName.Substring($prefix.Length).Replace('\', '/')
    } | Sort-Object)
}

$expectedFiles = @(Get-RelativeFiles -Root $expectedRoot)
$actualFiles = @(Get-RelativeFiles -Root $actualRoot)
if (($expectedFiles -join "`n") -cne ($actualFiles -join "`n")) {
    throw "sqlc generated file set drifted; expected [$($expectedFiles -join ', ')], got [$($actualFiles -join ', ')]"
}

foreach ($relativePath in $expectedFiles) {
    $platformPath = $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $expectedBytes = [IO.File]::ReadAllBytes((Join-Path $expectedRoot $platformPath))
    $actualBytes = [IO.File]::ReadAllBytes((Join-Path $actualRoot $platformPath))
    if ([Convert]::ToBase64String($expectedBytes) -cne [Convert]::ToBase64String($actualBytes)) {
        throw "sqlc generated content drifted: $relativePath"
    }
}
