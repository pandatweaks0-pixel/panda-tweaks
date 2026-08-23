# Creates a Windows System Restore Point and then PROVES it exists.
#
# Checkpoint-Computer can return without error and still create nothing — most
# commonly because Windows throttles restore point creation to one per 24 hours.
# Reporting that as success would be a lie, so this script compares the restore
# point list before and after and only reports success when a new point actually
# appeared.
#
# Input  (JSON via $env:PANDA_INPUT): { description, action }
#          action = "create" | "status"
# Output (JSON): { ok, reason, created, message, sequence, pointCount, points }

# stdout is read as UTF-8 by the caller. Without this line PowerShell encodes it
# in the console codepage (cp1252 on a German system), and every umlaut in a
# name or path comes back as a replacement character.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

$out = [ordered]@{
    ok         = $false
    reason     = ''
    created    = $false
    message    = ''
    sequence   = $null
    pointCount = $null
    points     = @()
}

function Emit {
    $out | ConvertTo-Json -Compress -Depth 5
    exit 0
}

# WMI timestamps need converting before they survive ConvertTo-Json. Wrapped in a
# function because try/catch is a statement in PowerShell 5.1 and cannot be used
# inline inside a hashtable literal.
function Get-PointTime($point) {
    try { return $point.ConvertToDateTime($point.CreationTime).ToString('o') } catch { return $null }
}

# Not $input — that name is an automatic variable holding pipeline input.
try {
    $cfg = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    $cfg = [pscustomobject]@{ description = 'Panda Tweaks'; action = 'status' }
}

$description = if ($cfg.description) { [string]$cfg.description } else { 'Panda Tweaks' }
$action = if ($cfg.action) { [string]$cfg.action } else { 'status' }

# --- elevation ---------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $out.reason = 'needs-admin'
    $out.message = 'Creating a restore point requires administrator rights.'
    Emit
}

# --- is System Protection on for the system drive? ---------------------------
# Get-ComputerRestorePoint fails outright when protection has never been on, so
# the two cases are told apart by probing the SR configuration first.
$srEnabled = $false
try {
    Get-CimInstance -Namespace 'root\default' -ClassName SystemRestoreConfig -ErrorAction Stop | Out-Null
    $srEnabled = $true
} catch {
    # Older/locked-down systems do not expose SystemRestoreConfig; fall through
    # and let the restore point listing decide.
}

$existing = @()
$listError = $null
try {
    $existing = @(Get-ComputerRestorePoint -ErrorAction Stop)
} catch {
    $listError = $_.Exception.Message
}

$out.pointCount = $existing.Count
$beforeMax = 0
if ($existing.Count -gt 0) {
    $beforeMax = ($existing | Measure-Object -Property SequenceNumber -Maximum).Maximum
}

if ($action -eq 'status') {
    $out.ok = $true
    $out.reason = if ($existing.Count -gt 0 -or $srEnabled) { 'available' } else { 'protection-unknown' }
    $out.sequence = $beforeMax
    $out.points = @($existing | Sort-Object SequenceNumber -Descending | Select-Object -First 10 | ForEach-Object {
        [ordered]@{
            sequence    = [int]$_.SequenceNumber
            description = [string]$_.Description
            created     = Get-PointTime $_
        }
    })
    Emit
}

# --- create ------------------------------------------------------------------
$cpError = $null
try {
    Checkpoint-Computer -Description $description -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
} catch {
    $cpError = $_.Exception.Message
}

# Verify by looking for a point that was not there before.
Start-Sleep -Milliseconds 1500
$after = @()
try {
    $after = @(Get-ComputerRestorePoint -ErrorAction Stop)
} catch {
    $after = @()
}
$afterMax = 0
if ($after.Count -gt 0) {
    $afterMax = ($after | Measure-Object -Property SequenceNumber -Maximum).Maximum
}

$out.pointCount = $after.Count
$out.sequence = $afterMax

if ($afterMax -gt $beforeMax) {
    $newest = $after | Sort-Object SequenceNumber -Descending | Select-Object -First 1
    $out.ok = $true
    $out.created = $true
    $out.reason = 'created'
    $out.message = "Restore point #$afterMax created."
    $out.points = @([ordered]@{
        sequence    = [int]$newest.SequenceNumber
        description = [string]$newest.Description
        created     = Get-PointTime $newest
    })
    Emit
}

# Nothing new appeared: work out why, and say so plainly.
if ($cpError) {
    $out.reason = 'error'
    $out.message = $cpError
} elseif ($listError -and $after.Count -eq 0) {
    $out.reason = 'protection-disabled'
    $out.message = 'System Protection appears to be turned off for this drive, so Windows cannot store restore points.'
} else {
    # Checkpoint-Computer reported no error but created nothing — the 24 hour
    # throttle (SystemRestorePointCreationFrequency) is the usual cause.
    $out.reason = 'throttled'
    $out.message = 'Windows did not create a new restore point. It only creates one every 24 hours by default, and a recent point already exists.'
}
Emit
