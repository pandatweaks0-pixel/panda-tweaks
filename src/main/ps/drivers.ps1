# Lists the third-party driver packages in the driver store. Read-only; needs
# administrator rights (Get-WindowsDriver refuses without them).
# Output (JSON): { ok, error, drivers: [ { inf, original, provider, className, version, date, bytes, inUse } ] }
#
# Get-WindowsDriver and CIM report data, not sentences, so nothing here depends
# on the system language - pnputil /enum-drivers would.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

try {
    # Which packages a device is bound to right now. The caller never offers
    # these, and pnputil refuses them anyway without /force.
    $inUse = @{}
    foreach ($d in Get-CimInstance Win32_PnPSignedDriver) {
        if ($d.InfName) { $inUse[([string]$d.InfName).ToLower()] = $true }
    }

    $list = foreach ($d in Get-WindowsDriver -Online) {
        $dir = Split-Path -Parent $d.OriginalFileName
        $bytes = (Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        [ordered]@{
            inf       = [string]$d.Driver
            original  = [string](Split-Path -Leaf $d.OriginalFileName)
            provider  = [string]$d.ProviderName
            className = [string]$d.ClassName
            version   = [string]$d.Version
            date      = if ($d.Date) { $d.Date.ToString('yyyy-MM-dd') } else { '' }
            bytes     = [int64]$bytes
            inUse     = [bool]$inUse[([string]$d.Driver).ToLower()]
        }
    }
    [ordered]@{ ok = $true; error = $null; drivers = @($list) } | ConvertTo-Json -Compress -Depth 4
} catch {
    [ordered]@{ ok = $false; error = $_.Exception.Message; drivers = @() } | ConvertTo-Json -Compress -Depth 4
}
