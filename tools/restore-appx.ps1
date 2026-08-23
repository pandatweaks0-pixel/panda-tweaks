# Puts a removed Store app back.
#
# Run this in an *administrator* PowerShell:
#   powershell -ExecutionPolicy Bypass -File tools\restore-appx.ps1
#   powershell -ExecutionPolicy Bypass -File tools\restore-appx.ps1 -Name Microsoft.WindowsCalculator
#
# Removing a Store app the way Panda Tweaks does it — Remove-AppxPackage without
# -AllUsers — unregisters it for one account. The actual files usually stay in
# C:\Program Files\WindowsApps, because Windows still keeps them for other
# accounts or as the copy new accounts get. When that is the case the app can be
# re-registered from disk: instant, offline, no Store, no account.
#
# Only when the payload is really gone does anything have to be downloaded.

param(
    [string]$Name = "Microsoft.ScreenSketch"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Host "Restoring: $Name" -ForegroundColor Cyan

if (Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue) {
    Write-Host "Already installed for this account. Nothing to do." -ForegroundColor Green
    exit 0
}

if (-not (Test-Admin)) {
    Write-Host "This needs an administrator PowerShell: the package files live under" -ForegroundColor Yellow
    Write-Host "C:\Program Files\WindowsApps, which a standard user cannot read." -ForegroundColor Yellow
    exit 1
}

# --- 1. the payload is still on disk for some account ------------------------
$payload = Get-AppxPackage -AllUsers -Name $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.InstallLocation -and (Test-Path (Join-Path $_.InstallLocation 'AppXManifest.xml')) } |
    Select-Object -First 1

if ($payload) {
    Write-Host "Found the package on disk: $($payload.PackageFullName)"
    try {
        Add-AppxPackage -DisableDevelopmentMode -Register (Join-Path $payload.InstallLocation 'AppXManifest.xml')
        Write-Host "Re-registered from disk. No download was needed." -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "Re-registering failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# --- 2. Windows still keeps a provisioned copy for new accounts --------------
$prov = Get-AppxProvisionedPackage -Online | Where-Object { $_.DisplayName -eq $Name } | Select-Object -First 1
if ($prov) {
    Write-Host "Found a provisioned copy: $($prov.PackageName)"
    $appx = Join-Path $env:ProgramFiles "WindowsApps\$($prov.PackageName)\AppXManifest.xml"
    if (Test-Path $appx) {
        try {
            Add-AppxPackage -DisableDevelopmentMode -Register $appx
            Write-Host "Re-registered from the provisioned copy." -ForegroundColor Green
            exit 0
        } catch {
            Write-Host "Re-registering failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# --- 3. nothing local left ---------------------------------------------------
Write-Host ""
Write-Host "The package files are gone from this machine, so it has to come back" -ForegroundColor Yellow
Write-Host "from the Microsoft Store. Either:" -ForegroundColor Yellow
Write-Host "  winget install --id 9MZ95KL8MR0L --source msstore --accept-package-agreements --accept-source-agreements"
Write-Host "  (that id is the Snipping Tool; other apps have their own)"
Write-Host "or open the Store page directly:"
Write-Host "  start ms-windows-store://pdp/?ProductId=9MZ95KL8MR0L"
exit 2
