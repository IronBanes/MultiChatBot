# Multichat starter for Windows. Run start.cmd (double-click) or: .\start.ps1 [options]
# Checks for (and offers to install) everything the app needs, then builds and runs it.
#
#   start.cmd                     run the app
#   start.cmd --server            also host the relay server for friends
#   start.cmd --instance bob      run a second local identity
#   start.cmd --yes ...           install missing pieces without asking

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$MinNodeMajor = 22
$MinRustMinor = 88 # Rust 1.88+ (the MCP client needs it)
$AssumeYes = $false
$PassThru = @()
foreach ($a in $args) {
    if ($a -eq '--yes' -or $a -eq '-y') { $AssumeYes = $true } else { $PassThru += $a }
}

function Say($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nError: $msg" -ForegroundColor Red; exit 1 }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Confirm($question) {
    if ($AssumeYes) { return $true }
    $reply = Read-Host "    $question [Y/n]"
    return ($reply -eq '' -or $reply -match '^[Yy]')
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}

function Winget-Install($id, $extra = @()) {
    if (-not (Have winget)) {
        Die "winget is not available. Install '$id' manually (or install App Installer from the Microsoft Store), then re-run."
    }
    & winget install --id $id -e --accept-package-agreements --accept-source-agreements @extra
    if ($LASTEXITCODE -ne 0) { Die "winget could not install $id (exit code $LASTEXITCODE)." }
    Refresh-Path
}

Refresh-Path

# ---------------------------------------------------------------- C++ build tools
Say 'Checking Microsoft C++ Build Tools'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasMsvc = $false
if (Test-Path $vswhere) {
    $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $hasMsvc = [bool]$found
}
if ($hasMsvc) {
    Ok 'installed'
} else {
    Warn 'missing (Rust needs the MSVC compiler and Windows SDK)'
    if (-not (Confirm 'Install Visual Studio Build Tools with the C++ workload (several GB)?')) { Die 'C++ Build Tools are required.' }
    Winget-Install 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
    Ok 'installed'
}

# ---------------------------------------------------------------- WebView2
Say 'Checking Microsoft Edge WebView2 Runtime'
$wv2Key = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv2 = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2Key",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv2Key",
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2Key"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($wv2) {
    Ok 'installed'
} else {
    Warn 'missing'
    if (-not (Confirm 'Install the WebView2 Runtime?')) { Die 'WebView2 is required to show the app window.' }
    Winget-Install 'Microsoft.EdgeWebView2Runtime'
    Ok 'installed'
}

# ---------------------------------------------------------------- Rust
Say 'Checking Rust'
if (-not (Have cargo) -or -not (Have rustc)) {
    Warn 'Rust is not installed'
    if (-not (Confirm 'Install Rust with rustup?')) { Die 'Rust is required.' }
    Winget-Install 'Rustlang.Rustup'
    if (-not (Have rustc)) { & rustup default stable }
}
$rustVersion = (& rustc --version)
if ($rustVersion -match '^rustc 1\.(\d+)' -and [int]$Matches[1] -lt $MinRustMinor) {
    Warn "$rustVersion is too old (need 1.$MinRustMinor or newer)"
    if (-not (Confirm 'Update Rust with rustup?')) { Die 'A newer Rust is required.' }
    & rustup update stable
    & rustup default stable
    $rustVersion = (& rustc --version)
}
Ok $rustVersion

# ---------------------------------------------------------------- Node.js
Say 'Checking Node.js'
function Node-Major {
    if (-not (Have node)) { return 0 }
    $v = (& node -v)
    if ($v -match '^v(\d+)') { return [int]$Matches[1] }
    return 0
}
if ((Node-Major) -lt $MinNodeMajor) {
    if (Have node) { Warn "Node $(& node -v) is too old (need $MinNodeMajor+)" } else { Warn 'Node.js is not installed' }
    if (-not (Confirm 'Install Node.js LTS?')) { Die "Node.js $MinNodeMajor+ is required." }
    Winget-Install 'OpenJS.NodeJS.LTS'
    if ((Node-Major) -lt $MinNodeMajor) { Die 'Node.js was installed but is not on PATH yet. Open a new terminal and re-run.' }
}
Ok "Node $(& node -v)"

# ---------------------------------------------------------------- build and run
& node app/scripts/launch.mjs @PassThru
exit $LASTEXITCODE
