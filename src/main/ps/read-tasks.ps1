# Batch-reads scheduled task state. Input (JSON via $env:PANDA_INPUT):
#   [ "\Microsoft\Windows\Application Experience\ProgramDataUpdater", ... ]
# Output (JSON): { taskPath: { exists, enabled } }

# stdout is read as UTF-8 by the caller. Without this line PowerShell encodes it
# in the console codepage (cp1252 on a German system), and every umlaut in a
# name or path comes back as a replacement character.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

$out = @{}
try {
    $paths = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

# One enumeration, then look tasks up in memory: Get-ScheduledTask per path is
# slow enough to be noticeable during a scan.
$index = @{}
try {
    foreach ($t in Get-ScheduledTask -ErrorAction Stop) {
        $full = ($t.TaskPath + $t.TaskName)
        $index[$full.ToLower()] = $t
    }
} catch {
    # ScheduledTasks module unavailable -> everything reported as missing.
}

foreach ($p in $paths) {
    $t = $index[([string]$p).ToLower()]
    if ($null -ne $t) {
        $out[[string]$p] = [ordered]@{
            exists  = $true
            # State: Ready/Running/Disabled. Anything that is not Disabled counts
            # as enabled.
            enabled = ([string]$t.State -ne 'Disabled')
        }
    } else {
        $out[[string]$p] = [ordered]@{ exists = $false; enabled = $false }
    }
}

$out | ConvertTo-Json -Compress -Depth 6
