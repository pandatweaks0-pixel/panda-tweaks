# Lists or removes Store app packages for the current user.
#
# Input (JSON via $env:PANDA_INPUT):
#   { action: "list",      patterns: [ "BingNews", ... ] }
#   { action: "installed" }                       -> every removable package
#   { action: "remove", names:    [ "Microsoft.BingNews", ... ] }
#
# Discovery matches loosely (the catalogue stores fragments like "BingNews"),
# but removal only ever accepts a resolved, exact package name. A wildcard is
# never handed to Remove-AppxPackage.
#
# Removal is per-user, so it needs no administrator rights and leaves other
# accounts on the machine untouched.

# stdout is read as UTF-8 by the caller. Without this line PowerShell encodes it
# in the console codepage (cp1252 on a German system), and every umlaut in a
# name or path comes back as a replacement character.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

try {
    $cfg = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

$action = if ($cfg.action) { [string]$cfg.action } else { 'list' }

$packages = @()
try {
    $packages = @(Get-AppxPackage -ErrorAction Stop)
} catch {
    # Appx subsystem unavailable: report nothing installed rather than guessing.
}

if ($action -eq 'installed') {
    # Everything the user could plausibly remove: no frameworks, no resource
    # packages, and nothing Windows itself marks as non-removable.
    $list = @($packages | Where-Object {
        -not $_.IsFramework -and -not $_.IsResourcePackage -and -not $_.NonRemovable
    } | ForEach-Object {
        [ordered]@{
            name      = [string]$_.Name
            fullName  = [string]$_.PackageFullName
            publisher = [string]$_.Publisher
            version   = [string]$_.Version
            signature = [string]$_.SignatureKind
        }
    })
    # Wrapped in an object so a single result never collapses into a bare object.
    @{ apps = $list } | ConvertTo-Json -Compress -Depth 6
    exit 0
}

if ($action -eq 'list') {
    $out = @{}
    foreach ($p in @($cfg.patterns)) {
        $pattern = [string]$p
        $matched = @($packages | Where-Object { $_.Name -like "*$pattern*" })
        $out[$pattern] = [ordered]@{
            installed = ($matched.Count -gt 0)
            names     = @($matched | ForEach-Object { [string]$_.Name })
            fullNames = @($matched | ForEach-Object { [string]$_.PackageFullName })
        }
    }
    $out | ConvertTo-Json -Compress -Depth 6
    exit 0
}

if ($action -eq 'register') {
    # Putting a removed app back without downloading anything.
    #
    # Remove-AppxPackage without -AllUsers unregisters the app for one account
    # and leaves the files under C:\Program Files\WindowsApps, because Windows
    # still keeps them for other accounts or as the copy new accounts get. When
    # that is so, the app can be registered again straight from disk.
    #
    # Reading that folder needs administrator rights, which is why this reports
    # "needs-admin" rather than "gone" when it cannot look.
    $out = @{}
    foreach ($n in @($cfg.names)) {
        $name = [string]$n
        $entry = [ordered]@{ ok = $false; error = $null; reason = $null }

        if (Get-AppxPackage -Name $name -ErrorAction SilentlyContinue) {
            $entry.ok = $true
            $entry.reason = 'already-installed'
            $out[$name] = $entry
            continue
        }

        $manifest = $null
        try {
            $payload = Get-AppxPackage -AllUsers -Name $name -ErrorAction Stop |
                Where-Object { $_.InstallLocation } | Select-Object -First 1
            if ($payload) {
                $candidate = Join-Path $payload.InstallLocation 'AppXManifest.xml'
                if (Test-Path -LiteralPath $candidate) { $manifest = $candidate }
            }
        } catch {
            $entry.reason = 'needs-admin'
            $entry.error = $_.Exception.Message
            $out[$name] = $entry
            continue
        }

        if ($null -eq $manifest) {
            $entry.reason = 'no-payload'
            $entry.error = 'The package files are no longer on this machine.'
            $out[$name] = $entry
            continue
        }

        try {
            Add-AppxPackage -DisableDevelopmentMode -Register $manifest -ErrorAction Stop
            # Verify rather than trust the absence of an error.
            if (Get-AppxPackage -Name $name -ErrorAction SilentlyContinue) {
                $entry.ok = $true
                $entry.reason = 'registered'
            } else {
                $entry.error = 'Windows reported no error, but the package is still not registered.'
            }
        } catch {
            $entry.error = $_.Exception.Message
        }
        $out[$name] = $entry
    }
    $out | ConvertTo-Json -Compress -Depth 6
    exit 0
}

# --- remove ------------------------------------------------------------------
$out = @{}
foreach ($n in @($cfg.names)) {
    $name = [string]$n
    $entry = [ordered]@{ installed = $false; removed = $false; error = $null }

    # Exact match only.
    $pkg = $packages | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($null -eq $pkg) {
        $entry.error = 'Package is not installed for this user.'
        $out[$name] = $entry
        continue
    }
    $entry.installed = $true

    try {
        Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction Stop
        # Verify it is actually gone before reporting success.
        $still = Get-AppxPackage -Name $pkg.Name -ErrorAction SilentlyContinue
        if ($null -eq $still) {
            $entry.removed = $true
            $entry.installed = $false
        } else {
            $entry.error = 'Windows reported no error, but the package is still installed.'
        }
    } catch {
        $entry.error = $_.Exception.Message
    }
    $out[$name] = $entry
}

$out | ConvertTo-Json -Compress -Depth 6
