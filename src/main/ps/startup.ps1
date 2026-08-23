# Lists and toggles autostart entries.
#
# Input (JSON via $env:PANDA_INPUT):
#   { action: "list" }
#   { action: "set", entries: [ { name: "...", scope: "hkcuRun", enabled: false } ] }
#
# Windows does not remove a Run value when you disable it in Task Manager. It
# writes a marker into ...\Explorer\StartupApproved\<source>, where the first
# byte is even for enabled and odd for disabled. Toggling that marker is what
# Task Manager itself does, so an entry disabled here shows as disabled there —
# and nothing about the original Run value or shortcut is destroyed.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

try {
    $cfg = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

# scope -> where the entry lives, and where its approval marker lives.
$SCOPES = @{
    hkcuRun    = @{ source = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run';                  approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' }
    hklmRun    = @{ source = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run';                  approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' }
    hklmRun32  = @{ source = 'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run';      approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32' }
    hkcuFolder = @{ source = ''; approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' }
    hklmFolder = @{ source = ''; approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' }
}

$FOLDERS = @{
    hkcuFolder = [Environment]::GetFolderPath('Startup')
    hklmFolder = [Environment]::GetFolderPath('CommonStartup')
}

# An absent marker means "never disabled", which is enabled.
function Get-Approval($approvedKey, $valueName) {
    $item = Get-ItemProperty -LiteralPath $approvedKey -Name $valueName -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $true }
    $bytes = $item.$valueName
    if ($null -eq $bytes -or $bytes.Count -lt 1) { return $true }
    return (([int]$bytes[0] -band 1) -eq 0)
}

if ($cfg.action -eq 'set') {
    $out = @{}
    foreach ($e in @($cfg.entries)) {
        $name = [string]$e.name
        $scope = [string]$e.scope
        $entry = [ordered]@{ ok = $false; error = $null }
        $def = $SCOPES[$scope]
        if ($null -eq $def) {
            $entry.error = "Unknown autostart scope: $scope"
            $out[$name] = $entry
            continue
        }
        try {
            if (-not (Test-Path -LiteralPath $def.approved)) {
                New-Item -Path $def.approved -Force -ErrorAction Stop | Out-Null
            }
            if ($e.enabled) {
                $bytes = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0)
            } else {
                # Disabled markers carry the time of disabling in the trailing
                # FILETIME; Task Manager shows it as "disabled on".
                $stamp = [BitConverter]::GetBytes((Get-Date).ToFileTime())
                $bytes = [byte[]](@(3,0,0,0) + $stamp)
            }
            New-ItemProperty -LiteralPath $def.approved -Name $name -Value $bytes -PropertyType Binary -Force -ErrorAction Stop | Out-Null
            # Read it back: a write that reported success but did not stick is
            # not a success.
            $entry.ok = ((Get-Approval $def.approved $name) -eq [bool]$e.enabled)
            if (-not $entry.ok) { $entry.error = 'The marker was written but did not take effect.' }
        } catch {
            $entry.error = $_.Exception.Message
        }
        $out[$name] = $entry
    }
    $out | ConvertTo-Json -Compress -Depth 6
    exit 0
}

# --- list --------------------------------------------------------------------
$list = @()

foreach ($scope in @('hkcuRun', 'hklmRun', 'hklmRun32')) {
    $def = $SCOPES[$scope]
    $key = Get-Item -LiteralPath $def.source -ErrorAction SilentlyContinue
    if ($null -eq $key) { continue }
    foreach ($valueName in $key.GetValueNames()) {
        if ([string]::IsNullOrWhiteSpace($valueName)) { continue }
        $list += [ordered]@{
            name    = [string]$valueName
            command = [string]$key.GetValue($valueName)
            scope   = $scope
            source  = [string]$def.source
            enabled = (Get-Approval $def.approved $valueName)
        }
    }
}

foreach ($scope in @('hkcuFolder', 'hklmFolder')) {
    $dir = $FOLDERS[$scope]
    if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue) {
        if ($file.Name -eq 'desktop.ini') { continue }
        $list += [ordered]@{
            name    = [string]$file.Name
            command = [string]$file.FullName
            scope   = $scope
            source  = [string]$dir
            enabled = (Get-Approval $SCOPES[$scope].approved $file.Name)
        }
    }
}

@{ entries = @($list) } | ConvertTo-Json -Compress -Depth 6
