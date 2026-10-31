# tinyprobe-app installer for Windows.
#
#   irm https://raw.githubusercontent.com/kikutano/tinyprobe-app/main/install.ps1 | iex
#
# It downloads the app, checks it against the release's SHA256SUMS, then runs `tinyprobe-app --install`:
# the app copies itself to %LOCALAPPDATA%\tinyprobe-app, adds tinyprobe to the Start menu and the desktop,
# and downloads tinyprobe if it is missing. Run it again to update the app.
#
# Environment variables:
#   TINYPROBE_APP_VERSION   version to install, e.g. 0.1.0 (default: latest release)
$ErrorActionPreference = 'Stop'

$repo = 'kikutano/tinyprobe-app'

# win-x64 also runs on Windows on ARM through x64 emulation.
$archive = 'tinyprobe-app-win-x64.zip'

$baseUrl = if ($env:TINYPROBE_APP_VERSION) {
    "https://github.com/$repo/releases/download/v$($env:TINYPROBE_APP_VERSION.TrimStart('v'))"
} else {
    "https://github.com/$repo/releases/latest/download"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    Write-Host "Downloading $baseUrl/$archive"
    Invoke-WebRequest "$baseUrl/$archive" -OutFile (Join-Path $tmp $archive) -UseBasicParsing
    Invoke-WebRequest "$baseUrl/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing
    $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match " $([regex]::Escape($archive))$" }
    $expected = ($line -split ' ')[0]
    $actual = (Get-FileHash (Join-Path $tmp $archive) -Algorithm SHA256).Hash
    if (-not $expected -or ($expected -ne $actual)) { throw "Checksum mismatch for ${archive}: nothing was installed." }

    Expand-Archive (Join-Path $tmp $archive) -DestinationPath $tmp -Force
    & (Join-Path $tmp 'tinyprobe-app.exe') --install
    if ($LASTEXITCODE -ne 0) { throw "tinyprobe-app --install failed (exit code $LASTEXITCODE)." }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
