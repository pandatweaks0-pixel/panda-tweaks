# Reads the global TCP and Teredo settings the netsh operation type writes.
# Input: ignored (there are only three cmdlets, so everything is read at once).
# Output (JSON): { autotuninglevel, ecncapability, timestamps, heuristics,
#                  rss, rsc, teredo }  - lowercase strings, or absent if unread.
#
# Why not "netsh int tcp show global": every caption in that output is
# translated ("ECN-Funktion", "RFC 1323-Zeitstempel"), so matching a caption
# works on exactly one Windows language, and matching by line position breaks
# the day Microsoft adds a row. These cmdlets return objects whose property
# names and values are English on every install.
#
# A setting that cannot be read is left out of the object entirely rather than
# guessed at, so the caller can tell "off" apart from "could not look".

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

$out = [ordered]@{}
$lower = { param($v) if ($null -eq $v) { $null } else { ([string]$v).ToLower() } }

try {
    $tcp = Get-NetTCPSetting -SettingName Internet -ErrorAction Stop
    if ($tcp) {
        if ($null -ne $tcp.AutoTuningLevelLocal) { $out.autotuninglevel = & $lower $tcp.AutoTuningLevelLocal }
        if ($null -ne $tcp.EcnCapability)        { $out.ecncapability   = & $lower $tcp.EcnCapability }
        if ($null -ne $tcp.Timestamps)           { $out.timestamps      = & $lower $tcp.Timestamps }
        if ($null -ne $tcp.ScalingHeuristics)    { $out.heuristics      = & $lower $tcp.ScalingHeuristics }
    }
} catch { }

try {
    $off = Get-NetOffloadGlobalSetting -ErrorAction Stop
    if ($off) {
        if ($null -ne $off.ReceiveSideScaling)       { $out.rss = & $lower $off.ReceiveSideScaling }
        if ($null -ne $off.ReceiveSegmentCoalescing) { $out.rsc = & $lower $off.ReceiveSegmentCoalescing }
    }
} catch { }

try {
    $ter = Get-NetTeredoConfiguration -ErrorAction Stop
    if ($ter -and $null -ne $ter.Type) { $out.teredo = & $lower $ter.Type }
} catch { }

$out | ConvertTo-Json -Compress -Depth 4
