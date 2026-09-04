"use strict";

// Builds dist/Optimize-This-PC.ps1 - a single file that applies a curated set
// of the catalogue's tweaks and writes its own undo script beside itself.
//
// The change table is GENERATED from tweaks.json. Retyping thirty registry
// paths into a script by hand is how a tool ends up writing to a key that no
// longer matches what the app writes, and the whole point of this project is
// that both can be checked against each other.
//
// What the script deliberately does NOT do, and why:
//
//   Nothing risky, and nothing driver-dependent. HAGS, MPO and TdrDelay are
//   left out for the same reason presets leave them out: their outcome depends
//   on your specific driver and the failure mode is a black screen, which is
//   the one state in which you cannot reach an undo button.
//
//   Nothing unproven. The mouse and keyboard queue sizes and the default TTL
//   are community tweaks with no measured benefit; a script that claims to
//   optimise should not pad its count with them.
//
//   Nothing that needs a decision. Debloating apps, disabling telemetry
//   services and removing hibernation are all defensible, and all of them take
//   something away that somebody wants. They stay in the app, where they are
//   chosen deliberately.
//
//   node tools/build-optimizer.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");
const { validateOp } = require(path.join(ROOT, "src", "main", "ops"));
const tweaks = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "tweaks.json"), "utf8"));

// --------------------------------------------------------------- selection --

// Chosen for a gaming desktop: real, repeatable effect, and a downside that is
// either none or is heat and idle power on a machine that is plugged in.
const PICKS = [
    // Windows: the background work that costs frames outright
    "win_game_mode", "win_gamedvr_off", "win_gamebar_off", "str_historical_capture_off",
    "win_visualfx", "win_transparency_off", "win_window_anim_off", "win_taskbar_anim_off",
    "win_menu_delay", "win_startup_delay", "win_aeroshake_off", "win_snap_flyout_off",
    "str_notifications_off", "win_error_reporting_off", "aud_ducking_off",
    // Windows will not restart out from under a match on its own schedule.
    // Its sibling win_no_driver_updates is deliberately NOT here: blocking
    // driver updates is reasonable once you are on a driver you like, and a
    // trap while you are behind - which the driver check below will tell you.
    "win_no_autoreboot",

    // Scheduling: tell Windows the game in front is what matters
    "cpu_priority", "cpu_mmcss", "cpu_mmcss_games", "mem_background_off",

    // Input: raw and consistent
    "win_mouse_accel_off", "win_stickykeys_off", "in_filterkeys_off", "in_togglekeys_off",
    "in_kbd_repeat", "in_hover_time", "in_xbox_button_off",

    // Network: restore sane defaults and stop the multimedia throttle
    "net_tcp_optimize", "net_throttle_off", "net_qos_off", "net_do_off", "net_rsc_off",
];

// Right on one machine and wrong on the next, so the script checks before it
// writes rather than trusting where it was generated. Same three conditions the
// app applies in machineFit(); a script that skipped them would be handing a
// laptop the exact set the app refuses it.
const CONDITIONAL = {
    // Everything that keeps hardware awake: fine plugged in, ruinous on battery.
    desktop: [
        "cpu_minstate100", "cpu_coreparking_off", "cpu_powerthrottle_off",
        "cpu_usb_suspend_off", "cpu_pcie_aspm_off",
    ],
    // Prefetching genuinely helps a spinning disk; turning it off there hurts.
    ssd: ["mem_prefetch_off", "mem_sysmain_off"],
    // Holding the kernel in RAM is only a trade worth making with RAM to spare.
    ram16: ["cpu_pagingexec"],
};

const byId = new Map(tweaks.map((t) => [t.id, t]));
const usable = (t) => {
    try { (t.operations || []).forEach(validateOp); return true; } catch { return false; }
};

// Only these can be carried out by a plain PowerShell script.
const SUPPORTED = new Set(["registry", "service", "powercfg", "netsh"]);

const POWER = {
    procMinState: { sub: "SUB_PROCESSOR", setting: "PROCTHROTTLEMIN" },
    coreParkingMin: { sub: "SUB_PROCESSOR", setting: "CPMINCORES" },
    cpuIdleDisable: { sub: "SUB_PROCESSOR", setting: "IDLEDISABLE" },
    usbSelectiveSuspend: { sub: "2a737441-1930-4402-8d77-b2bebba308a3", setting: "48e6b7a6-50f5-4782-a5d4-53bb8f07e226" },
    pcieAspm: { sub: "501a4d13-42af-4429-9fd1-a8218c268e20", setting: "ee12f906-d277-404b-b6da-e5fa1a576df5" },
    displayTimeout: { sub: "SUB_VIDEO", setting: "VIDEOIDLE" },
};

const NETSH = {
    autotuninglevel: ["int", "tcp", "set", "global", "autotuninglevel="],
    ecncapability: ["int", "tcp", "set", "global", "ecncapability="],
    timestamps: ["int", "tcp", "set", "global", "timestamps="],
    heuristics: ["int", "tcp", "set", "heuristics", " "],
    rss: ["int", "tcp", "set", "global", "rss="],
    rsc: ["int", "tcp", "set", "global", "rsc="],
    teredo: ["interface", "teredo", "set", "state", " "],
};

const problems = [];
const changes = [];

function collect(id, requires) {
    const t = byId.get(id);
    if (!t) { problems.push(`no such tweak: ${id}`); return; }
    if (!usable(t)) { problems.push(`${id} is not usable`); return; }
    if (t.risk === "risky") { problems.push(`${id} is risky and must not be in the optimizer`); return; }
    for (const op of t.operations || []) {
        if (!SUPPORTED.has(op.type)) { problems.push(`${id}: ${op.type} cannot be scripted`); continue; }
        changes.push({ id, name: t.name, op, requires });
    }
}

for (const id of PICKS) collect(id, "");
for (const [requirement, ids] of Object.entries(CONDITIONAL)) {
    for (const id of ids) collect(id, requirement);
}

// A tweak listed twice would be applied twice and captured twice, and the
// second capture would record the first one's value as "before".
const seen = new Set();
for (const c of changes) {
    const k = `${c.id}|${JSON.stringify(c.op)}`;
    if (seen.has(k)) problems.push(`${c.id} appears more than once`);
    seen.add(k);
}

if (problems.length) {
    console.error("Refusing to write the optimizer:");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
}

// ------------------------------------------------------------------ emit --

const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

function rowFor(c) {
    const o = c.op;
    if (o.type === "registry") {
        const hive = o.hive === "HKLM" ? "HKLM:" : "HKCU:";
        const kind = o.valueType === "REG_SZ" ? "String" : "DWord";
        const value = o.valueType === "REG_SZ" ? ps(o.value) : String(Number(o.value));
        return `  @{ Kind='registry'; Needs=${ps(c.requires)}; Tweak=${ps(c.name)}; Path=${ps(hive + "\\" + o.key)}; Name=${ps(o.name)}; Value=${value}; Type=${ps(kind)} }`;
    }
    if (o.type === "service") {
        const mode = o.startMode === "manual" ? "demand" : o.startMode;
        return `  @{ Kind='service'; Needs=${ps(c.requires)}; Tweak=${ps(c.name)}; Name=${ps(o.name)}; Start=${ps(mode)} }`;
    }
    if (o.type === "powercfg") {
        if (o.action === "hibernate") return `  @{ Kind='hibernate'; Needs=${ps(c.requires)}; Tweak=${ps(c.name)}; On=$${o.enabled} }`;
        const e = POWER[o.setting];
        return `  @{ Kind='power'; Needs=${ps(c.requires)}; Tweak=${ps(c.name)}; Sub=${ps(e.sub)}; Setting=${ps(e.setting)}; Value=${Number(o.value)} }`;
    }
    const a = NETSH[o.setting];
    return `  @{ Kind='netsh'; Needs=${ps(c.requires)}; Tweak=${ps(c.name)}; Key=${ps(o.setting)}; Args=@(${a.slice(0, 4).map(ps).join(",")}); Suffix=${ps(a[4])}; Value=${ps(o.value)} }`;
}

const names = [...new Set(changes.map((c) => c.name))];

const script = `# ============================================================================
#  Optimize This PC  -  Panda Tweaks
#
#  Applies ${names.length} tweaks in one run, and writes an undo script beside
#  itself containing the values THIS machine had before anything was changed.
#  Nothing here is guessed: every previous value is read first, and undo puts
#  back what was actually there rather than an assumed Windows default.
#
#  Generated by tools/build-optimizer.js from the same catalogue the app ships.
#  Do not edit by hand - regenerate it.
#
#  Right-click -> Run with PowerShell, or:
#     powershell -ExecutionPolicy Bypass -File .\\Optimize-This-PC.ps1
# ============================================================================

[CmdletBinding()]
param(
    # Show what would change and write nothing.
    [switch]$WhatIfOnly,
    # Skip the System Restore point (it can take a minute on some machines).
    [switch]$NoRestorePoint
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- administrator ----------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'This needs administrator rights. Restarting elevated...' -ForegroundColor Yellow
    $argList = @('-ExecutionPolicy','Bypass','-File',"\`"$PSCommandPath\`"")
    if ($WhatIfOnly)     { $argList += '-WhatIfOnly' }
    if ($NoRestorePoint) { $argList += '-NoRestorePoint' }
    try { Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -ErrorAction Stop }
    catch { Write-Host 'Declined. Nothing was changed.' -ForegroundColor Red; Read-Host 'Enter to close'; }
    return
}

Write-Host ''
Write-Host '  PANDA TWEAKS - one-shot optimizer' -ForegroundColor Cyan
Write-Host '  ---------------------------------' -ForegroundColor Cyan
Write-Host ''

# ---------- what kind of machine is this? ------------------------------------
# Read, not assumed. Some of the changes below are right on one PC and wrong on
# the next, and the whole difference between a tweak and a mistake is whether
# anyone checked first.

$isLaptop = $false
try {
    $chassis = (Get-CimInstance Win32_SystemEnclosure -EA Stop | Select-Object -First 1).ChassisTypes
    foreach ($ct in $chassis) { if (@(8,9,10,11,12,13,14,30,31,32) -contains [int]$ct) { $isLaptop = $true } }
    if (-not $isLaptop -and @(Get-CimInstance Win32_Battery -EA SilentlyContinue).Count -gt 0) { $isLaptop = $true }
} catch { }

$driveType = $null
try { $driveType = (Get-PhysicalDisk -EA Stop | Select-Object -First 1).MediaType } catch { }

$ramGB = $null
try { $ramGB = [math]::Round((Get-CimInstance Win32_OperatingSystem -EA Stop).TotalVisibleMemorySize / 1MB, 1) } catch { }

$cpu = $null; $gpu = $null
try { $cpu = (Get-CimInstance Win32_Processor -EA Stop | Select-Object -First 1).Name } catch { }
try { $gpu = (Get-CimInstance Win32_VideoController -EA Stop | Where-Object { $_.AdapterRAM -ne $null } | Select-Object -First 1).Name } catch { }

Write-Host ('  ' + $(if ($isLaptop) { 'Laptop' } else { 'Desktop' }) +
            $(if ($cpu) { ' - ' + ($cpu -replace '\s+', ' ').Trim() }) ) -ForegroundColor DarkGray
if ($gpu)      { Write-Host "  $gpu" -ForegroundColor DarkGray }
Write-Host ("  {0} GB RAM, system drive: {1}" -f $(if ($ramGB) { $ramGB } else { '?' }),
            $(if ($driveType) { $driveType } else { 'unknown' })) -ForegroundColor DarkGray
Write-Host ''

# Unproven counts as not met: "I could not tell whether this helps or hurts" is
# not a reason to do it to somebody's machine.
$Met = @{
    ''        = @{ Ok = $true;  Why = '' }
    'desktop' = @{ Ok = (-not $isLaptop); Why = 'this is a laptop - keeping the hardware awake costs more battery than it gains' }
    'ssd'     = @{ Ok = ($driveType -eq 'SSD'); Why = $(if ($driveType) { "the system drive is $driveType - prefetching actually helps there" } else { 'the system drive type could not be read, and this hurts on a hard disk' }) }
    'ram16'   = @{ Ok = ($null -ne $ramGB -and $ramGB -ge 16); Why = $(if ($ramGB) { "$ramGB GB is not enough for this to be a good trade" } else { 'the amount of RAM could not be read' }) }
}

# ---------- the changes ------------------------------------------------------
$Changes = @(
${changes.map(rowFor).join("\n")}
)

# ---------- the things a script cannot change -------------------------------
# Measured, not assumed, and reported whether the answer is good or bad. On a
# well-kept machine every line here comes back green, and that is worth seeing:
# a tool that only ever lists problems teaches you to distrust it when it finds
# none. These four also outweigh every registry value further down.

Write-Host '  System check' -ForegroundColor White

function Say($label, $good, $detail) {
    $mark  = if ($good) { 'ok  ' } else { 'note' }
    $color = if ($good) { 'Green' } else { 'Yellow' }
    Write-Host ("    [{0}] {1,-26} {2}" -f $mark, $label, $detail) -ForegroundColor $color
}

# GPU driver age. In a UE5 game a driver a year old costs more frames than
# everything this script does put together.
try {
    # Get-CimInstance already hands back a DateTime here, while the older
    # Get-WmiObject returned a DMTF string. Converting unconditionally threw,
    # and an empty catch then swallowed the single most useful line on the
    # screen - so this accepts either and says so when it can read neither.
    # Win32_VideoController, not Win32_PnPSignedDriver. On this machine the two
    # report the same driver version with day and month transposed - 2025-12-02
    # against 2025-02-12, a difference of nearly a year - and there is no way to
    # tell from here which provider is swapping them. The app reads
    # VideoController, so the script reads it too: a tool that contradicts its
    # own app teaches you to trust neither.
    $drv = Get-CimInstance Win32_VideoController -EA Stop |
           Where-Object { $_.DriverDate } |
           Select-Object -First 1
    if (-not $drv) {
        Say 'GPU driver' $true 'no display driver reported a date'
    } else {
        $date = $null
        if ($drv.DriverDate -is [datetime]) { $date = $drv.DriverDate }
        else { try { $date = [Management.ManagementDateTimeConverter]::ToDateTime([string]$drv.DriverDate) } catch { } }

        if ($null -eq $date) {
            Say 'GPU driver' $false "version $($drv.DriverVersion) - release date unreadable"
        } else {
            $days = [int]((Get-Date) - $date).TotalDays
            Say 'GPU driver' ($days -le 120) "$days days old (released $($date.ToString('yyyy-MM-dd')))"
            if ($days -gt 120) { Write-Host '           -> update it before judging anything below' -ForegroundColor DarkGray }
        }
    }
} catch {
    Say 'GPU driver' $false "could not be read ($($_.Exception.Message))"
}

# Monitor running below what it can do is extremely common and instantly fixed.
try {
    $mode = Get-CimInstance Win32_VideoController -EA Stop | Where-Object { $_.CurrentRefreshRate } | Select-Object -First 1
    if ($mode) {
        $now = [int]$mode.CurrentRefreshRate; $max = [int]$mode.MaxRefreshRate
        Say 'Refresh rate' ($max -le 0 -or $now -ge $max) "$now Hz$(if ($max -gt 0) { " of $max Hz" })"
        if ($max -gt 0 -and $now -lt $max) { Write-Host '           -> Settings > System > Display > Advanced display' -ForegroundColor DarkGray }
    }
} catch { }

# RAM below its rated speed means XMP/EXPO is off in the BIOS. Nothing in
# Windows can fix it, and it is worth more than any tweak here.
try {
    $sticks = Get-CimInstance Win32_PhysicalMemory -EA Stop
    $run = ($sticks | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum
    $rated = ($sticks | Measure-Object -Property Speed -Maximum).Maximum
    if ($run -and $rated) {
        Say 'Memory speed' ($run -ge $rated) "$run MHz of $rated MHz rated"
        if ($run -lt $rated) { Write-Host '           -> switch on XMP (Intel) or EXPO (AMD) in the BIOS' -ForegroundColor DarkGray }
    }
} catch { }

# A full system drive slows everything, including shader caches.
try {
    $sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'" -EA Stop
    $freePct = [int](100 * $sys.FreeSpace / $sys.Size)
    Say 'Free space' ($freePct -ge 15) "$freePct% free ($([int]($sys.FreeSpace/1GB)) GB)"
} catch { }

# Startup programs are named rather than counted: "9 entries" is not something
# anyone can act on.
try {
    $startup = @(Get-CimInstance Win32_StartupCommand -EA Stop | Select-Object -ExpandProperty Name -Unique)
    Say 'Startup programs' ($startup.Count -le 6) "$($startup.Count) entries"
    if ($startup.Count -gt 6) { Write-Host ('           -> ' + ($startup -join ', ')) -ForegroundColor DarkGray }
} catch { }

Write-Host ''

# ---------- restore point ----------------------------------------------------
if (-not $WhatIfOnly -and -not $NoRestorePoint) {
    Write-Host 'Creating a system restore point...' -NoNewline
    try {
        Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
        Checkpoint-Computer -Description 'Before Panda Tweaks optimizer' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
        Write-Host ' done.' -ForegroundColor Green
    } catch {
        Write-Host ' could not be created.' -ForegroundColor Yellow
        Write-Host "  ($($_.Exception.Message))" -ForegroundColor DarkGray
        Write-Host '  System Protection may be off. The undo script below still works.' -ForegroundColor DarkGray
    }
    Write-Host ''
}

# ---------- helpers ----------------------------------------------------------
function Read-Reg($Path, $Name) {
    try {
        $item = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
        return @{ Exists = $true; Value = $item.$Name }
    } catch { return @{ Exists = $false; Value = $null } }
}

function Read-PowerAc($Sub, $Setting) {
    try {
        $out = powercfg /query SCHEME_CURRENT $Sub $Setting 2>$null
        # The captions are translated; the two current indices are always the
        # last two hex numbers, mains before battery.
        $hex = [regex]::Matches(($out -join "\`n"), '0x[0-9a-fA-F]{8}')
        if ($hex.Count -lt 2) { return $null }
        return [Convert]::ToInt32($hex[$hex.Count - 2].Value, 16)
    } catch { return $null }
}

function Read-Netsh($Key) {
    try {
        switch ($Key) {
            'autotuninglevel' { return (Get-NetTCPSetting -SettingName Internet -EA Stop).AutoTuningLevelLocal }
            'ecncapability'   { return (Get-NetTCPSetting -SettingName Internet -EA Stop).EcnCapability }
            'timestamps'      { return (Get-NetTCPSetting -SettingName Internet -EA Stop).Timestamps }
            'heuristics'      { return (Get-NetTCPSetting -SettingName Internet -EA Stop).ScalingHeuristics }
            'rss'             { return (Get-NetOffloadGlobalSetting -EA Stop).ReceiveSideScaling }
            'rsc'             { return (Get-NetOffloadGlobalSetting -EA Stop).ReceiveSegmentCoalescing }
            'teredo'          { return (Get-NetTeredoConfiguration -EA Stop).Type }
        }
    } catch { return $null }
    return $null
}

# ---------- apply ------------------------------------------------------------
$undo = New-Object System.Collections.ArrayList
$applied = 0; $skipped = 0; $failed = 0
$lastTweak = ''

$heldBack = New-Object System.Collections.ArrayList

foreach ($c in $Changes) {
    if ($c.Tweak -ne $lastTweak) { Write-Host ("  " + $c.Tweak) -ForegroundColor White; $lastTweak = $c.Tweak }

    $need = $Met[$c.Needs]
    if (-not $need.Ok) {
        Write-Host ("      left out: " + $need.Why) -ForegroundColor DarkYellow
        if (-not $heldBack.Contains($c.Tweak)) { [void]$heldBack.Add($c.Tweak) }
        $skipped++
        continue
    }

    try {
        switch ($c.Kind) {
            'registry' {
                $before = Read-Reg $c.Path $c.Name
                if ($before.Exists -and "$($before.Value)" -eq "$($c.Value)") {
                    Write-Host '      already set' -ForegroundColor DarkGray; $skipped++; break
                }
                if ($WhatIfOnly) { Write-Host "      would set $($c.Name) = $($c.Value)" -ForegroundColor DarkCyan; break }
                if (-not (Test-Path -LiteralPath $c.Path)) { New-Item -Path $c.Path -Force | Out-Null }
                New-ItemProperty -LiteralPath $c.Path -Name $c.Name -Value $c.Value -PropertyType $c.Type -Force | Out-Null
                [void]$undo.Add(@{ Kind='registry'; Path=$c.Path; Name=$c.Name; Existed=$before.Exists; Value=$before.Value; Type=$c.Type })
                Write-Host "      $($c.Name) = $($c.Value)" -ForegroundColor Green; $applied++
            }
            'service' {
                $svc = Get-Service -Name $c.Name -ErrorAction SilentlyContinue
                if (-not $svc) { Write-Host '      not installed - nothing to do' -ForegroundColor DarkGray; $skipped++; break }
                $before = (Get-CimInstance Win32_Service -Filter "Name='$($c.Name)'").StartMode
                if ($WhatIfOnly) { Write-Host "      would set start type to $($c.Start)" -ForegroundColor DarkCyan; break }
                & sc.exe config $c.Name start= $c.Start | Out-Null
                [void]$undo.Add(@{ Kind='service'; Name=$c.Name; Start=$before })
                Write-Host "      start type -> $($c.Start)" -ForegroundColor Green; $applied++
            }
            'power' {
                $before = Read-PowerAc $c.Sub $c.Setting
                if ($null -ne $before -and $before -eq $c.Value) { Write-Host '      already set' -ForegroundColor DarkGray; $skipped++; break }
                if ($WhatIfOnly) { Write-Host "      would set power value to $($c.Value)" -ForegroundColor DarkCyan; break }
                & powercfg /setacvalueindex SCHEME_CURRENT $c.Sub $c.Setting $c.Value | Out-Null
                & powercfg /setactive SCHEME_CURRENT | Out-Null
                if ($null -ne $before) { [void]$undo.Add(@{ Kind='power'; Sub=$c.Sub; Setting=$c.Setting; Value=$before }) }
                Write-Host "      power value -> $($c.Value)" -ForegroundColor Green; $applied++
            }
            'netsh' {
                $before = Read-Netsh $c.Key
                if ($null -ne $before -and "$before".ToLower() -eq $c.Value) {
                    Write-Host '      already set' -ForegroundColor DarkGray; $skipped++; break
                }
                if ($WhatIfOnly) { Write-Host "      would set $($c.Key) = $($c.Value)" -ForegroundColor DarkCyan; break }
                if ($c.Suffix -eq ' ') { & netsh.exe $c.Args $c.Value | Out-Null }
                else { & netsh.exe $c.Args[0] $c.Args[1] $c.Args[2] $c.Args[3] ($c.Suffix + $c.Value) | Out-Null }
                Write-Host "      $($c.Value)" -ForegroundColor Green; $applied++
            }
        }
    } catch {
        Write-Host "      failed: $($_.Exception.Message)" -ForegroundColor Red; $failed++
    }
}

# ---------- write the undo script -------------------------------------------
if (-not $WhatIfOnly -and $undo.Count -gt 0) {
    $stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
    $undoPath = Join-Path (Split-Path -Parent $PSCommandPath) "Undo-Optimize-$stamp.ps1"

    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Undo for the Panda Tweaks optimizer run of $stamp.")
    [void]$lines.Add("# These are the values THIS machine had before that run - not defaults.")
    [void]$lines.Add("\`$ErrorActionPreference = 'Continue'")
    foreach ($u in $undo) {
        switch ($u.Kind) {
            'registry' {
                $p = $u.Path -replace "'", "''"
                $n = $u.Name -replace "'", "''"
                if ($u.Existed) {
                    $v = if ($u.Type -eq 'String') { "'" + ($u.Value -replace "'", "''") + "'" } else { [int]$u.Value }
                    [void]$lines.Add("New-ItemProperty -LiteralPath '$p' -Name '$n' -Value $v -PropertyType '$($u.Type)' -Force | Out-Null")
                } else {
                    [void]$lines.Add("Remove-ItemProperty -LiteralPath '$p' -Name '$n' -ErrorAction SilentlyContinue")
                }
            }
            'service' {
                $m = switch ($u.Start) { 'Auto' {'auto'} 'Manual' {'demand'} 'Disabled' {'disabled'} default {'demand'} }
                [void]$lines.Add("& sc.exe config '$($u.Name)' start= $m | Out-Null")
            }
            'power' {
                [void]$lines.Add("& powercfg /setacvalueindex SCHEME_CURRENT '$($u.Sub)' '$($u.Setting)' $($u.Value) | Out-Null")
                [void]$lines.Add("& powercfg /setactive SCHEME_CURRENT | Out-Null")
            }
        }
    }
    [void]$lines.Add("Write-Host 'Undone. A restart makes every change take effect.' -ForegroundColor Green")
    [void]$lines.Add("Read-Host 'Enter to close'")
    Set-Content -LiteralPath $undoPath -Value $lines -Encoding UTF8

    Write-Host ''
    Write-Host "  Undo script written:" -ForegroundColor Cyan
    Write-Host "  $undoPath"
}

# ---------- summary ----------------------------------------------------------
Write-Host ''
Write-Host "  $applied applied, $skipped skipped or already in place, $failed failed" -ForegroundColor Cyan
if ($heldBack.Count -gt 0) {
    Write-Host ''
    Write-Host "  Held back because of this machine ($($heldBack.Count)):" -ForegroundColor DarkYellow
    foreach ($h in $heldBack) { Write-Host "    - $h" -ForegroundColor DarkGray }
    Write-Host '    They stay available in the app, where you can apply them deliberately.' -ForegroundColor DarkGray
}
Write-Host '  Restart to have everything take effect.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  What this could NOT do for you, and matters more than all of it:' -ForegroundColor White
Write-Host '    1. Update your GPU driver. A driver a year old costs more frames' -ForegroundColor Gray
Write-Host '       in a UE5 game than every setting above combined.' -ForegroundColor Gray
Write-Host '    2. In Fortnite: set Rendering Mode to Performance. On a mid-range' -ForegroundColor Gray
Write-Host '       CPU that is the single largest gain available anywhere.' -ForegroundColor Gray
Write-Host '    3. Turn on XMP/EXPO in the BIOS if your RAM runs below its rating.' -ForegroundColor Gray
Write-Host ''
Read-Host '  Enter to close'
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, "Optimize-This-PC.ps1");
fs.writeFileSync(outFile, script, "utf8");

console.log(`dist/Optimize-This-PC.ps1 written - ${(Buffer.byteLength(script) / 1024).toFixed(1)} KB`);
console.log(`  ${names.length} tweaks, ${changes.length} operations`);
const kinds = {};
for (const c of changes) kinds[c.op.type] = (kinds[c.op.type] || 0) + 1;
console.log("  " + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", "));
