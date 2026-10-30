$ErrorActionPreference = 'Stop'
$apiRoot = Split-Path $PSScriptRoot -Parent
$localRoot = Join-Path $apiRoot '.local'
$archive = Join-Path $localRoot 'downloads\postgresql-16.15-5-windows-x64-binaries.zip'
$expected = '43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281'
$url = 'https://get.enterprisedb.com/postgresql/postgresql-16.15-5-windows-x64-binaries.zip'

# Official EDB binaries. No Windows service, registry, PATH, firewall or admin changes.
New-Item -ItemType Directory -Force (Split-Path $archive -Parent) | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 600
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'PostgreSQL archive checksum mismatch. No binaries have been executed.'
}
if (Test-Path -LiteralPath (Join-Path $localRoot 'pgsql\bin\postgres.exe')) {
    & (Join-Path $localRoot 'pgsql\bin\postgres.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'Existing local PostgreSQL binaries failed to start.' }
    exit 0
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
$allowedRoot = [System.IO.Path]::GetFullPath($localRoot) + [System.IO.Path]::DirectorySeparatorChar
try {
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/' -or $entry.FullName.EndsWith('/')) { continue }
        $target = [System.IO.Path]::GetFullPath((Join-Path $localRoot $entry.FullName))
        if (-not $target.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Archive entry escapes the local runtime directory.'
        }
        New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally {
    $zip.Dispose()
}
& (Join-Path $localRoot 'pgsql\bin\postgres.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL needs a Windows runtime dependency; installation stopped.' }
Write-Output 'Official PostgreSQL runtime installed inside this project.'
