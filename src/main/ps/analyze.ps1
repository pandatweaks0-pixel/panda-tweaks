# Read-only system analysis. This script must never change anything: every call
# here is a query. Anything that cannot be determined is reported as $null and
# rendered as "Unknown" in the UI, rather than guessed at.
#
# Output: one JSON object on stdout.

# stdout is read as UTF-8 by the caller. Without this line PowerShell encodes it
# in the console codepage (cp1252 on a German system), and every umlaut in a
# name or path comes back as a replacement character.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Try-Get($block) {
    try { & $block } catch { $null }
}

$r = [ordered]@{}

# --- Windows -----------------------------------------------------------------
$os = Try-Get { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
$cv = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$r.windows = [ordered]@{
    caption     = if ($os) { [string]$os.Caption } else { $null }
    edition     = Try-Get { [string](Get-ItemProperty $cv -ErrorAction Stop).EditionID }
    displayVer  = Try-Get { [string](Get-ItemProperty $cv -ErrorAction Stop).DisplayVersion }
    build       = if ($os) { [int]$os.BuildNumber } else { $null }
    ubr         = Try-Get { [int](Get-ItemProperty $cv -ErrorAction Stop).UBR }
    arch        = if ($os) { [string]$os.OSArchitecture } else { $null }
    installDate = if ($os) { $os.InstallDate.ToString('yyyy-MM-dd') } else { $null }
    lastBoot    = if ($os) { $os.LastBootUpTime.ToString('o') } else { $null }
    uptimeHours = if ($os) { [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1) } else { $null }
}
# Windows 11 kept the 10.0 kernel version; the build number is the real marker.
$r.windows.isWin11 = ($r.windows.build -ne $null -and $r.windows.build -ge 22000)

# --- Hardware ----------------------------------------------------------------
$cpu = Try-Get { Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 }
$r.cpu = [ordered]@{
    name         = if ($cpu) { $cpu.Name.Trim() } else { $null }
    cores        = if ($cpu) { [int]$cpu.NumberOfCores } else { $null }
    threads      = if ($cpu) { [int]$cpu.NumberOfLogicalProcessors } else { $null }
    maxClockMHz  = if ($cpu) { [int]$cpu.MaxClockSpeed } else { $null }
}

$gpus = Try-Get { @(Get-CimInstance Win32_VideoController -ErrorAction Stop) }
$r.gpus = @()
if ($gpus) {
    foreach ($g in $gpus) {
        $r.gpus += [ordered]@{
            name           = [string]$g.Name
            driverVersion  = [string]$g.DriverVersion
            driverDate     = if ($g.DriverDate) { $g.DriverDate.ToString('yyyy-MM-dd') } else { $null }
            driverAgeDays  = if ($g.DriverDate) { [int]((Get-Date) - $g.DriverDate).TotalDays } else { $null }
            currentRefresh = [int]$g.CurrentRefreshRate
            maxRefresh     = [int]$g.MaxRefreshRate
            horizontalRes  = [int]$g.CurrentHorizontalResolution
            verticalRes    = [int]$g.CurrentVerticalResolution
        }
    }
}

$mem = Try-Get { @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop) }
$r.ram = [ordered]@{
    totalGB        = if ($os) { [math]::Round($os.TotalVisibleMemorySize / 1MB, 1) } else { $null }
    freeGB         = if ($os) { [math]::Round($os.FreePhysicalMemory / 1MB, 1) } else { $null }
    sticks         = if ($mem) { $mem.Count } else { $null }
    ratedMHz       = if ($mem) { [int]($mem | Measure-Object -Property Speed -Maximum).Maximum } else { $null }
    configuredMHz  = if ($mem) { [int]($mem | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum } else { $null }
}

# Chassis types 8-14 and 30-32 are portable form factors.
$chassis = Try-Get { (Get-CimInstance Win32_SystemEnclosure -ErrorAction Stop | Select-Object -First 1).ChassisTypes }
$battery = Try-Get { @(Get-CimInstance Win32_Battery -ErrorAction Stop).Count }
$r.isLaptop = $false
if ($chassis) {
    foreach ($c in $chassis) { if (@(8,9,10,11,12,13,14,30,31,32) -contains [int]$c) { $r.isLaptop = $true } }
}
if (-not $r.isLaptop -and $battery -gt 0) { $r.isLaptop = $true }

$r.drives = @()
$disks = Try-Get { @(Get-PhysicalDisk -ErrorAction Stop) }
foreach ($d in (Try-Get { @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop) })) {
    $r.drives += [ordered]@{
        letter  = [string]$d.DeviceID
        totalGB = [math]::Round($d.Size / 1GB)
        freeGB  = [math]::Round($d.FreeSpace / 1GB)
        freePct = if ($d.Size -gt 0) { [math]::Round($d.FreeSpace / $d.Size * 100) } else { $null }
    }
}
# MediaType is the only reliable SSD/HDD signal, and it needs the Storage module.
$r.systemDriveType = $null
if ($disks) {
    $sys = $disks | Select-Object -First 1
    $r.systemDriveType = [string]$sys.MediaType
}

# --- Security ----------------------------------------------------------------
# Confirm-SecureBootUEFI needs elevation; the registry mirror does not.
$r.secureBoot = Try-Get {
    $v = (Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -Name UEFISecureBootEnabled -ErrorAction Stop).UEFISecureBootEnabled
    [bool]$v
}
$tpm = Try-Get { Get-CimInstance -Namespace 'root\CIMV2\Security\MicrosoftTpm' -ClassName Win32_Tpm -ErrorAction Stop }
$r.tpm = [ordered]@{
    present = if ($tpm) { $true } else { $null }   # $null = could not determine (usually needs admin)
    enabled = if ($tpm) { [bool]$tpm.IsEnabled_InitialValue } else { $null }
    version = if ($tpm) { [string]$tpm.SpecVersion } else { $null }
}

$sysPol = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$r.uac = [ordered]@{
    enabled       = Try-Get { [int](Get-ItemProperty $sysPol -Name EnableLUA -ErrorAction Stop).EnableLUA -eq 1 }
    consentPrompt = Try-Get { [int](Get-ItemProperty $sysPol -Name ConsentPromptBehaviorAdmin -ErrorAction Stop).ConsentPromptBehaviorAdmin }
}

$mp = Try-Get { Get-MpComputerStatus -ErrorAction Stop }
$r.defender = [ordered]@{
    available          = ($mp -ne $null)
    realtimeEnabled    = if ($mp) { [bool]$mp.RealTimeProtectionEnabled } else { $null }
    antivirusEnabled   = if ($mp) { [bool]$mp.AntivirusEnabled } else { $null }
    tamperProtection   = if ($mp) { [bool]$mp.IsTamperProtected } else { $null }
    signatureAgeDays   = if ($mp) { [int]$mp.AntivirusSignatureAge } else { $null }
}
$r.firewall = Try-Get {
    $profiles = Get-NetFirewallProfile -ErrorAction Stop
    @($profiles | Where-Object { -not $_.Enabled }).Count -eq 0
}
$r.hvci = Try-Get {
    [int](Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity' -Name Enabled -ErrorAction Stop).Enabled
}

# --- Windows Update ----------------------------------------------------------
$r.windowsUpdate = [ordered]@{
    serviceStartMode = Try-Get { [string](Get-CimInstance Win32_Service -Filter "Name='wuauserv'" -ErrorAction Stop).StartMode }
    serviceState     = Try-Get { [string](Get-CimInstance Win32_Service -Filter "Name='wuauserv'" -ErrorAction Stop).State }
    lastInstall      = Try-Get {
        $h = Get-HotFix -ErrorAction Stop | Sort-Object InstalledOn -Descending | Select-Object -First 1
        if ($h.InstalledOn) { $h.InstalledOn.ToString('yyyy-MM-dd') } else { $null }
    }
    pausedUntil      = Try-Get { [string](Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -Name PauseFeatureUpdatesEndTime -ErrorAction Stop).PauseFeatureUpdatesEndTime }
}

# --- Power / gaming ----------------------------------------------------------
# powercfg prints the plan name localized but the GUID is stable, so the GUID is
# what gets compared and the name is only shown.
$r.powerPlan = Try-Get {
    $line = (powercfg /getactivescheme | Out-String)
    if ($line -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
        $guid = $Matches[1]
        $name = if ($line -match '\(([^)]+)\)\s*$') { $Matches[1].Trim() } else { $null }
        [ordered]@{ name = $name; guid = $guid }
    } else { $null }
}
$r.gameMode = Try-Get { [int](Get-ItemProperty 'Registry::HKEY_CURRENT_USER\Software\Microsoft\GameBar' -Name AutoGameModeEnabled -ErrorAction Stop).AutoGameModeEnabled -eq 1 }
$r.gameDvr  = Try-Get { [int](Get-ItemProperty 'Registry::HKEY_CURRENT_USER\System\GameConfigStore' -Name GameDVR_Enabled -ErrorAction Stop).GameDVR_Enabled -eq 1 }
$r.hags     = Try-Get { [int](Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction Stop).HwSchMode }

# --- Privacy / telemetry -----------------------------------------------------
$dc = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Windows\DataCollection'
$cdm = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
$r.privacy = [ordered]@{
    telemetryLevel     = Try-Get { [int](Get-ItemProperty $dc -Name AllowTelemetry -ErrorAction Stop).AllowTelemetry }
    advertisingId      = Try-Get { [int](Get-ItemProperty 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo' -Name Enabled -ErrorAction Stop).Enabled }
    tailoredExperience = Try-Get { [int](Get-ItemProperty 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Privacy' -Name TailoredExperiencesWithDiagnosticDataEnabled -ErrorAction Stop).TailoredExperiencesWithDiagnosticDataEnabled }
    startSuggestions   = Try-Get { [int](Get-ItemProperty $cdm -Name SystemPaneSuggestionsEnabled -ErrorAction Stop).SystemPaneSuggestionsEnabled }
    tipsAndTricks      = Try-Get { [int](Get-ItemProperty $cdm -Name SubscribedContent-338389Enabled -ErrorAction Stop).'SubscribedContent-338389Enabled' }
    silentAppInstall   = Try-Get { [int](Get-ItemProperty $cdm -Name SilentInstalledAppsEnabled -ErrorAction Stop).SilentInstalledAppsEnabled }
    activityFeed       = Try-Get { [int](Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Windows\System' -Name EnableActivityFeed -ErrorAction Stop).EnableActivityFeed }
    locationConsent    = Try-Get { [string](Get-ItemProperty 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location' -Name Value -ErrorAction Stop).Value }
    diagTrackStart     = Try-Get { [string](Get-CimInstance Win32_Service -Filter "Name='DiagTrack'" -ErrorAction Stop).StartMode }
}

# --- Components --------------------------------------------------------------
$r.components = [ordered]@{
    oneDriveInstalled = Try-Get { (Test-Path "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe") -or (Test-Path "$env:ProgramFiles\Microsoft OneDrive\OneDrive.exe") }
    # SilentlyContinue keeps "not running" as $false instead of collapsing to
    # $null, which the UI would render as "Unknown".
    oneDriveRunning   = [bool](@(Get-Process OneDrive -ErrorAction SilentlyContinue).Count -gt 0)
    copilotPresent    = Try-Get { @(Get-AppxPackage -Name '*Copilot*' -ErrorAction Stop).Count -gt 0 }
    recallPresent     = Try-Get { (Get-WindowsOptionalFeature -Online -FeatureName 'Recall' -ErrorAction Stop).State -eq 'Enabled' }
    edgeInstalled     = Try-Get { Test-Path "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
}

# Appx enumeration is the slow part of this script, so it happens once and every
# consumer works off this list.
$appx = Try-Get { @(Get-AppxPackage -ErrorAction Stop | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable }) }
$r.installedApps = @()
if ($appx) {
    foreach ($a in $appx) {
        $r.installedApps += [ordered]@{
            name        = [string]$a.Name
            fullName    = [string]$a.PackageFullName
            publisher   = [string]$a.Publisher
        }
    }
}
$r.xboxApps = @()
if ($appx) {
    foreach ($a in ($appx | Where-Object { $_.Name -like '*Xbox*' -or $_.Name -like '*GamingApp*' })) {
        $r.xboxApps += [string]$a.Name
    }
}

# Enumerating optional features goes through DISM, which refuses without
# elevation. Left as $null (-> "Unknown") rather than an empty list, so the UI
# never claims the machine has no optional features enabled.
$features = Try-Get { @(Get-WindowsOptionalFeature -Online -ErrorAction Stop | Where-Object { $_.State -eq 'Enabled' }) }
if ($null -eq $features) {
    $r.optionalFeatures = $null
} else {
    $r.optionalFeatures = @($features | ForEach-Object { [string]$_.FeatureName })
}

# --- Startup -----------------------------------------------------------------
$r.startup = @()
foreach ($s in (Try-Get { @(Get-CimInstance Win32_StartupCommand -ErrorAction Stop) })) {
    $r.startup += [ordered]@{
        name     = [string]$s.Name
        command  = [string]$s.Command
        location = [string]$s.Location
    }
}

# --- Services / tasks (counts only; details are loaded on demand) -------------
$svc = Try-Get { @(Get-CimInstance Win32_Service -ErrorAction Stop) }
$r.serviceCounts = [ordered]@{
    total    = if ($svc) { $svc.Count } else { $null }
    running  = if ($svc) { @($svc | Where-Object { $_.State -eq 'Running' }).Count } else { $null }
    disabled = if ($svc) { @($svc | Where-Object { $_.StartMode -eq 'Disabled' }).Count } else { $null }
}
$r.scheduledTaskCount = Try-Get { @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.State -ne 'Disabled' }).Count }

$r | ConvertTo-Json -Compress -Depth 8
