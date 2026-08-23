# Undoes a "disable Windows Update permanently" tweak.
#
# Run in an *administrator* PowerShell:
#   powershell -ExecutionPolicy Bypass -File tools\unlock-update-services.ps1
#
# What that tweak does, and why nothing else undoes it:
#
#   1. It sets the services' Start value to 4 (Disabled).
#   2. It then strips every write permission from the service's registry key —
#      for Administrators AND for SYSTEM. Only read access is left.
#
# After step 2 nothing can turn the service back on: not Settings, not
# `sc config`, not an elevated shell, not Windows' own repair service. The
# permissions have to be restored first, and only then does the start type
# become writable again.
#
# The owner of those keys is still the Administrators group, and an owner may
# always rewrite the DACL, so this needs no ownership takeover — just elevation.
#
# Both the old permissions and the old policy values are written to
# %APPDATA%\Panda Tweaks before anything changes.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "This has to run in an administrator PowerShell." -ForegroundColor Yellow
    exit 1
}

$backupDir = "$env:APPDATA\Panda Tweaks"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
$stamp = Get-Date -Format yyyy-MM-dd-HHmm

# --- the policy block --------------------------------------------------------
# A fake WSUS server plus "no access" policies keeps Windows Update broken even
# once the service runs.
$polKey = 'HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
if (Test-Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate") {
    $polBackup = Join-Path $backupDir "windowsupdate-policy-backup-$stamp.reg"
    reg.exe export $polKey $polBackup /y | Out-Null
    Write-Host "policy backup : $polBackup"
    reg.exe delete $polKey /f | Out-Null
    Write-Host "policy block  : removed" -ForegroundColor Green
} else {
    Write-Host "policy block  : none present"
}

# --- the service keys --------------------------------------------------------
# 2 = Automatic, 3 = Manual
$targets = [ordered]@{ 'wuauserv' = 3; 'DoSvc' = 2; 'WaaSMedicSvc' = 3; 'BITS' = 3; 'UsoSvc' = 2 }

$admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$sddlBackup = @()

foreach ($svc in $targets.Keys) {
    $keyPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$svc"
    if (-not (Test-Path $keyPath)) { Write-Host "$svc : not on this machine"; continue }

    Write-Host ""
    Write-Host "=== $svc ==="
    try {
        $acl = Get-Acl $keyPath
        $sddlBackup += "$svc = $($acl.Sddl)"

        foreach ($sid in @($admins, $system)) {
            $rule = New-Object System.Security.AccessControl.RegistryAccessRule(
                $sid,
                [System.Security.AccessControl.RegistryRights]::FullControl,
                @([System.Security.AccessControl.InheritanceFlags]::ContainerInherit),
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow)
            $acl.SetAccessRule($rule)
        }
        Set-Acl -Path $keyPath -AclObject $acl -ErrorAction Stop
        Write-Host "  permissions restored for Administrators and SYSTEM" -ForegroundColor Green
    } catch {
        Write-Host "  permissions unchanged: $($_.Exception.Message)" -ForegroundColor Yellow
        continue
    }

    try {
        Set-ItemProperty $keyPath -Name Start -Value $targets[$svc] -Type DWord -ErrorAction Stop
        Write-Host "  Start = $((Get-ItemProperty $keyPath -Name Start).Start) (wanted $($targets[$svc]))"
    } catch {
        Write-Host "  start type unchanged: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if ($sddlBackup.Count) {
    $file = Join-Path $backupDir "service-key-permissions-backup-$stamp.txt"
    $sddlBackup -join "`r`n" | Out-File -FilePath $file -Encoding utf8
    Write-Host ""
    Write-Host "permissions backup: $file"
}

# --- start it ----------------------------------------------------------------
Write-Host ""
try {
    Start-Service wuauserv -ErrorAction Stop
    Write-Host "wuauserv started" -ForegroundColor Green
} catch {
    Write-Host "wuauserv did not start: $($_.Exception.Message)" -ForegroundColor Yellow
}

gpupdate.exe /force /target:computer | Out-Null

$after = Get-CimInstance Win32_Service -Filter "Name='wuauserv'"
Write-Host ""
Write-Host "RESULT: wuauserv $($after.StartMode) / $($after.State)" -ForegroundColor Cyan
Write-Host "Check Settings > Windows Update afterwards; the first scan can take a minute."
