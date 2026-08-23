# Batch-reads registry values. Input (JSON via $env:PANDA_INPUT):
#   [ { id, path, name }, ... ]   path = full provider path, e.g.
#                                 "Registry::HKEY_CURRENT_USER\Software\Foo"
# Output (JSON): { id: { exists, type, value } }
#
# Reading ~200 values in one process beats spawning reg.exe per value.

# stdout is read as UTF-8 by the caller. Without this line PowerShell encodes it
# in the console codepage (cp1252 on a German system), and every umlaut in a
# name or path comes back as a replacement character.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

$out = @{}
try {
    $items = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

foreach ($i in $items) {
    $res = [ordered]@{ exists = $false; type = ''; value = $null }
    try {
        $key = Get-Item -LiteralPath $i.path -ErrorAction Stop
        if ($key.GetValueNames() -contains $i.name) {
            $res.exists = $true
            $res.type = [string]$key.GetValueKind($i.name)
            # DoNotExpandEnvironmentNames keeps REG_EXPAND_SZ verbatim, so writing
            # the captured value back during an undo restores the original literal.
            $v = $key.GetValue($i.name, $null, 'DoNotExpandEnvironmentNames')
            if ($v -is [byte[]]) {
                $res.value = (($v | ForEach-Object { $_.ToString('x2') }) -join '')
            } elseif ($v -is [string[]]) {
                $res.value = ($v -join "`0")
            } else {
                $res.value = [string]$v
            }
        }
    } catch {
        # Key missing or access denied -> reported as "does not exist".
    }
    $out[[string]$i.id] = $res
}

$out | ConvertTo-Json -Compress -Depth 6
