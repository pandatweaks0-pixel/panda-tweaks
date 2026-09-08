# Reads Windows switches that have no registry value behind them - the state
# lives inside a tool and only a cmdlet will tell you.
#
# Input (JSON via $env:PANDA_INPUT):  { "settings": ["memoryCompression"] }
# Output (JSON): { "<setting>": { "ok": true, "enabled": false } }
#
# Both of these need administrator rights to *read*, not just to write. Without
# them the cmdlets throw "access denied", which is reported here as ok = false.
# That has to stay separate from "read it, it is off": an undo that mistook the
# one for the other would switch something back on that was never on.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

try {
    $req = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

$out = @{}

foreach ($setting in $req.settings) {
    $res = [ordered]@{ ok = $false; enabled = $false }
    try {
        if ($setting -eq 'memoryCompression') {
            $v = (Get-MMAgent -ErrorAction Stop).MemoryCompression
            if ($null -ne $v) { $res.ok = $true; $res.enabled = [bool]$v }
        } elseif ($setting -eq 'pageCombining') {
            $v = (Get-MMAgent -ErrorAction Stop).PageCombining
            if ($null -ne $v) { $res.ok = $true; $res.enabled = [bool]$v }
        } elseif ($setting -eq 'reservedStorage') {
            $v = (Get-WindowsReservedStorageState -ErrorAction Stop).ReservedStorageState
            if ($v) { $res.ok = $true; $res.enabled = ([string]$v -eq 'Enabled') }
        }
    } catch {
        # Left at ok = false: not readable is not the same as switched off.
    }
    $out[[string]$setting] = $res
}

$out | ConvertTo-Json -Compress -Depth 4
