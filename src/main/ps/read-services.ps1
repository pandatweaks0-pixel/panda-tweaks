# Batch-reads service state. Input (JSON via $env:PANDA_INPUT): [ "DiagTrack", ... ]
# Output (JSON): { name: { exists, startMode, state } }
#
# Uses CIM rather than parsing sc.exe: sc.exe output is localized, CIM property
# values are not.

# stdout is read as UTF-8 by the caller. Without this line PowerShell encodes it
# in the console codepage (cp1252 on a German system), and every umlaut in a
# name or path comes back as a replacement character.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

$out = @{}
try {
    $names = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

$all = @{}
try {
    foreach ($s in Get-CimInstance Win32_Service -ErrorAction Stop) {
        $all[$s.Name.ToLower()] = $s
    }
} catch {
    # WMI unavailable -> every service reported as missing rather than guessed at.
}

foreach ($n in $names) {
    $svc = $all[([string]$n).ToLower()]
    if ($null -ne $svc) {
        $out[[string]$n] = [ordered]@{
            exists    = $true
            startMode = [string]$svc.StartMode   # Boot|System|Auto|Manual|Disabled
            state     = [string]$svc.State       # Running|Stopped|...
            display   = [string]$svc.DisplayName
        }
    } else {
        $out[[string]$n] = [ordered]@{ exists = $false; startMode = ''; state = ''; display = '' }
    }
}

$out | ConvertTo-Json -Compress -Depth 6
