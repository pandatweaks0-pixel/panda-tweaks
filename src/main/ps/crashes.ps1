# Reads what Windows recorded about crashes and black screens. Read-only.
# Output (JSON): { bugchecks, powerLoss, displayResets, hardwareErrors, liveReports }, last 180 days
#
# Every value comes from event properties or file metadata, never from the
# event message: messages are localized, properties are not.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$since = (Get-Date).AddDays(-180)
$iso = { param($d) $d.ToUniversalTime().ToString('o') }

function Events($filter, $max = 50) {
    $filter.LogName = 'System'
    $filter.StartTime = $since
    @(Get-WinEvent -FilterHashtable $filter -MaxEvents $max -ErrorAction SilentlyContinue)
}

# "The computer has rebooted from a bugcheck" - the blue screen itself.
$bugchecks = foreach ($e in Events @{ ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting', 'BugCheck'; Id = 1001 }) {
    $raw = [string]$e.Properties[0].Value
    [ordered]@{ at = & $iso $e.TimeCreated; code = $raw; dump = [string]$e.Properties[1].Value }
}

# Kernel-Power 41: the PC went down without shutting down. A bugcheck code of 0
# means no blue screen was involved - a hard freeze or the power going away.
$powerLoss = foreach ($e in Events @{ ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41 }) {
    [ordered]@{ at = & $iso $e.TimeCreated; bugcheck = [int64]$e.Properties[0].Value }
}

# Display 4101: the graphics driver hung and Windows reset it - the classic
# "screen goes black for a few seconds" event.
$displayResets = foreach ($e in Events @{ ProviderName = 'Display'; Id = 4101 }) {
    [ordered]@{ at = & $iso $e.TimeCreated; driver = [string]$e.Properties[0].Value }
}

# WHEA: the CPU, RAM or PCIe bus reported a hardware error. 18 and 1 are fatal,
# 19 and 47 were corrected but still mean something is running at its limit.
$hardwareErrors = foreach ($e in Events @{ ProviderName = 'Microsoft-Windows-WHEA-Logger' } 100) {
    [ordered]@{ at = & $iso $e.TimeCreated; id = [int]$e.Id }
}

# Hangs Windows recovered from without a blue screen; the folder name is the
# component (WATCHDOG is the graphics timeout).
$liveReports = foreach ($f in Get-ChildItem -LiteralPath "$env:WINDIR\LiveKernelReports" -Recurse -File -Filter *.dmp -ErrorAction SilentlyContinue) {
    if ($f.LastWriteTime -ge $since) {
        [ordered]@{ at = & $iso $f.LastWriteTime; kind = $f.Directory.Name; name = $f.Name }
    }
}

[ordered]@{
    bugchecks      = @($bugchecks)
    powerLoss      = @($powerLoss)
    displayResets  = @($displayResets)
    hardwareErrors = @($hardwareErrors)
    liveReports    = @($liveReports)
} | ConvertTo-Json -Compress -Depth 5
