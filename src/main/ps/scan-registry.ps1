# Enumerates the device keys a "registryScan" operation may write to.
#
# Input (JSON via $env:PANDA_INPUT):  { "scopes": ["usbInput", "audioRender"] }
# Output (JSON): { "<scope>": { "ok": true, "keys": ["SYSTEM\\...", ...] } }
#
# The scope names are a fixed set decided here, not a path handed in from a data
# file: nothing a tweak declares reaches this script as a registry path. Every
# key returned is relative to HKLM, and the caller checks it still sits under the
# root that scope is allowed to touch before writing anything.
#
# "ok" is separate from an empty list on purpose. A PC without Bluetooth returns
# an empty list and that is a real answer; an enumeration that threw returns
# ok = false, because "found nothing" and "could not look" must not lead to the
# same conclusion.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'SilentlyContinue'

$ENUM_ROOT = 'HKLM:\SYSTEM\CurrentControlSet\Enum'

try {
    $req = Get-Content -Raw -LiteralPath $env:PANDA_INPUT | ConvertFrom-Json
} catch {
    '{}'
    exit 0
}

# Get-ChildItem hands back "HKEY_LOCAL_MACHINE\SYSTEM\..."; the rest of the app
# speaks the path without the hive.
function Strip-Hive($name) {
    return ($name -replace '^HKEY_LOCAL_MACHINE\\', '')
}

# A device instance id becomes a key under Enum. Only report it if the key is
# really there — Get-PnpDevice also lists devices that are not currently present.
function Add-EnumInstance($list, $instanceId) {
    if (-not $instanceId) { return }
    $p = Join-Path $ENUM_ROOT $instanceId
    if (Test-Path -LiteralPath $p) {
        [void]$list.Add((Strip-Hive (Get-Item -LiteralPath $p).Name))
    }
}

$out = @{}

foreach ($scope in $req.scopes) {
    $list = New-Object System.Collections.ArrayList
    $ok = $true

    try {
        if ($scope -eq 'usbInput' -or $scope -eq 'usbController') {
            # Both walk Enum\USB\<vid_pid>\<instance>; they differ only in which
            # driver service marks a device as "the kind this tweak is about".
            $filter = if ($scope -eq 'usbInput') {
                '^(HidUsb|kbdhid|mouhid)$'
            } else {
                '^(xusb22|WinUSB|HidUsb|BthUsb)$'
            }
            $usb = Get-ChildItem -LiteralPath (Join-Path $ENUM_ROOT 'USB') -ErrorAction Stop
            foreach ($vid in $usb) {
                foreach ($inst in (Get-ChildItem -LiteralPath $vid.PSPath)) {
                    $svc = (Get-ItemProperty -LiteralPath $inst.PSPath -Name Service).Service
                    if ($svc -and $svc -match $filter) {
                        [void]$list.Add((Strip-Hive $inst.Name))
                    }
                }
            }
        } elseif ($scope -eq 'bluetooth') {
            foreach ($d in (Get-PnpDevice -Class Bluetooth -ErrorAction Stop)) {
                Add-EnumInstance $list $d.InstanceId
            }
        } elseif ($scope -eq 'gpu') {
            foreach ($g in (Get-CimInstance Win32_VideoController -ErrorAction Stop)) {
                Add-EnumInstance $list $g.PNPDeviceID
            }
        } elseif ($scope -eq 'audioRender') {
            $root = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
            foreach ($k in (Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
                # Windows keeps an endpoint here for every playback device it has
                # ever seen - 54 of them on a normal PC, most long gone. Only
                # DEVICE_STATE_ACTIVE (0x1) and UNPLUGGED (0x8) are devices the
                # user actually has; NOTPRESENT and DISABLED are history.
                $state = (Get-ItemProperty -LiteralPath $k.PSPath -Name DeviceState).DeviceState
                if ($null -ne $state -and ($state -band 0x9)) {
                    [void]$list.Add((Strip-Hive $k.Name))
                }
            }
        } elseif ($scope -eq 'netAdapters') {
            # Network card settings live in the driver's class key, not under
            # Enum. Only physical adapters are considered - the class is full of
            # VPN, loopback and virtual entries - and only keys that already
            # carry the value, so a card whose driver does not support interrupt
            # moderation never has the setting invented for it.
            $guids = @{}
            foreach ($a in (Get-NetAdapter -Physical -ErrorAction Stop)) {
                if ($a.InterfaceGuid) { $guids[([string]$a.InterfaceGuid).ToLower()] = $true }
            }
            $classRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
            # The root has to be there, but individual subkeys under it can be
            # locked down - one of them always is on a normal machine. Enumerating
            # strictly turns that single refusal into "no network cards found".
            if (-not (Test-Path -LiteralPath $classRoot)) { throw "network class key missing" }
            foreach ($k in (Get-ChildItem -LiteralPath $classRoot -ErrorAction SilentlyContinue)) {
                if ($k.PSChildName -notmatch '^\d{4}$') { continue }
                $props = Get-ItemProperty -LiteralPath $k.PSPath
                $id = [string]$props.NetCfgInstanceId
                if (-not $id -or -not $guids.ContainsKey($id.ToLower())) { continue }
                if ($null -eq $props.'*InterruptModeration') { continue }
                [void]$list.Add((Strip-Hive $k.Name))
            }
        } elseif ($scope -eq 'tcpInterfaces') {
            $root = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
            foreach ($k in (Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
                [void]$list.Add((Strip-Hive $k.Name))
            }
        } else {
            # An unknown scope is a bug in the caller, not an empty result.
            $ok = $false
        }
    } catch {
        $ok = $false
    }

    # ConvertTo-Json turns a one-element array into a bare value; the caller
    # expects a list either way.
    $out[[string]$scope] = [ordered]@{ ok = $ok; keys = @($list.ToArray()) }
}

$out | ConvertTo-Json -Compress -Depth 6
