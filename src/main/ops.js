"use strict";

// The operations layer. A tweak is a list of these; there is no path that
// executes an arbitrary command string. Every operation type knows how to:
//
//   capture(ops)      read the current system state (batched)
//   isApplied(op,cur) decide whether the desired state is already in place
//   apply(op)         move the system to the desired state
//   restore(op,prev)  put the captured previous state back
//   describe(op)      say in plain text exactly what is touched
//
// restore() takes the state captured at apply time — not a hardcoded revert
// command — so undoing a tweak returns the value the user actually had.

const fs = require("fs");
const path = require("path");
const { run, runPsJson } = require("./shell");

const PS_DIR = path.join(__dirname, "ps");

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const HIVES = {
    HKCU: { provider: "Registry::HKEY_CURRENT_USER", short: "HKCU", admin: false },
    HKLM: { provider: "Registry::HKEY_LOCAL_MACHINE", short: "HKLM", admin: true },
    HKCR: { provider: "Registry::HKEY_CLASSES_ROOT", short: "HKCR", admin: true },
    HKU: { provider: "Registry::HKEY_USERS", short: "HKU", admin: true },
};

const REG_TYPES = new Set([
    "REG_SZ",
    "REG_EXPAND_SZ",
    "REG_DWORD",
    "REG_QWORD",
    "REG_BINARY",
    "REG_MULTI_SZ",
]);

// PowerShell reports RegistryValueKind; the rest of the app speaks REG_*.
const KIND_TO_REG = {
    String: "REG_SZ",
    ExpandString: "REG_EXPAND_SZ",
    DWord: "REG_DWORD",
    QWord: "REG_QWORD",
    Binary: "REG_BINARY",
    MultiString: "REG_MULTI_SZ",
};

function validateRegistry(op) {
    const hive = HIVES[String(op.hive || "").toUpperCase()];
    if (!hive) throw new Error(`Unknown registry hive: ${op.hive}`);
    const key = String(op.key || "");
    if (!key || /["\r\n]/.test(key)) throw new Error(`Invalid registry key: ${op.key}`);
    const name = String(op.name ?? "");
    if (/[\r\n]/.test(name)) throw new Error(`Invalid registry value name: ${op.name}`);
    const action = op.action === "delete" ? "delete" : "set";
    if (action === "set") {
        const type = String(op.valueType || "REG_DWORD").toUpperCase();
        if (!REG_TYPES.has(type)) throw new Error(`Unsupported registry type: ${op.valueType}`);
        if (op.value === undefined || op.value === null)
            throw new Error(`Registry set without a value: ${key}\\${name}`);
        return { ...op, hive: hive.short, key, name, action, valueType: type, value: String(op.value) };
    }
    return { ...op, hive: hive.short, key, name, action };
}

// DWORD read back as 0x1 must compare equal to a declared 1; binary is compared
// case-insensitively as hex.
function normalizeRegValue(type, value) {
    if (value === null || value === undefined) return null;
    const s = String(value);
    if (type === "REG_DWORD" || type === "REG_QWORD") {
        const n = /^0x/i.test(s) ? Number.parseInt(s, 16) : Number.parseInt(s, 10);
        if (Number.isNaN(n)) return s;
        // A DWORD comes back from .NET as a signed 32-bit integer, so a value
        // with the top bit set arrives negative: 0xFFFFFFFF reads as -1 while
        // the tweak that wrote it declares 4294967295. Without this, every
        // tweak using the high half of the range is permanently undetectable —
        // it reports "not applied" immediately after applying successfully.
        if (type === "REG_DWORD" && n < 0 && n >= -0x8000_0000) return String(n + 0x1_0000_0000);
        return String(n);
    }
    if (type === "REG_BINARY") return s.replace(/[\s,]/g, "").toLowerCase();
    return s;
}

function regProviderPath(op) {
    return `${HIVES[op.hive].provider}\\${op.key}`;
}

function regShortPath(op) {
    return `${HIVES[op.hive].short}\\${op.key}`;
}

async function captureRegistry(ops) {
    if (!ops.length) return new Map();
    const input = ops.map((op, idx) => ({
        id: String(idx),
        path: regProviderPath(op),
        name: op.name,
    }));
    const res = await runPsJson(path.join(PS_DIR, "read-registry.ps1"), input, {});
    const out = new Map();
    for (let i = 0; i < ops.length; i++) {
        const raw = res.data ? res.data[String(i)] : null;
        if (!res.ok || !raw) {
            // A failed read must not be mistaken for "value absent" — that would
            // make an undo delete a value that was actually there.
            out.set(ops[i], { readFailed: true, error: res.error || "registry read failed" });
        } else {
            out.set(ops[i], {
                exists: !!raw.exists,
                valueType: KIND_TO_REG[raw.type] || raw.type || "",
                value: raw.value,
            });
        }
    }
    return out;
}

function registryIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null; // unknown, not "no"
    if (op.action === "delete") return !cur.exists;
    if (!cur.exists) return false;
    return (
        normalizeRegValue(op.valueType, cur.value) === normalizeRegValue(op.valueType, op.value)
    );
}

function regArgs(op, verb, extra = []) {
    const args = [verb, regShortPath(op)];
    if (op.name === "") args.push("/ve");
    else args.push("/v", op.name);
    return args.concat(extra, ["/f"]);
}

// reg.exe says "access denied" for two very different situations, and the
// difference is the whole answer for the user.
//
// Under HKLM it means what it says: run as administrator. Under HKCU it cannot
// mean that — that hive belongs to the user. Recent Windows builds protect
// individual values there (the Widgets and taskbar settings are the well-known
// ones): the key is writable, the single value is not, and no amount of
// elevation changes it. Reported as a plain failure it looks like a bug in this
// app, and the user retries it forever.
const DENIED = /access is denied|zugriff verweigert|acceso denegado|accès refusé/i;

function regWriteError(op, res) {
    const text = res.stderr || res.stdout || res.error || `reg exited ${res.code}`;
    if (!DENIED.test(text)) return text;
    return HIVES[op.hive].admin
        ? `Access denied — ${op.hive} needs administrator rights.`
        : `Windows protects this value on this build: the key is writable, but "${op.name}" is not, and elevation does not change that.`;
}

async function regSet(op, valueType, value) {
    // reg.exe encodes the REG_MULTI_SZ separator as a literal backslash-zero.
    const data = valueType === "REG_MULTI_SZ" ? String(value).replace(/\0/g, "\\0") : String(value);
    const res = await run("reg.exe", regArgs(op, "add", ["/t", valueType, "/d", data]));
    return res.ok ? { ok: true } : { ok: false, error: regWriteError(op, res) };
}

async function regDelete(op) {
    const res = await run("reg.exe", regArgs(op, "delete"));
    if (res.ok) return { ok: true };
    // Deleting something that is already gone is the desired end state.
    if (/cannot find|nicht gefunden/i.test(res.stderr + res.stdout)) return { ok: true };
    return { ok: false, error: regWriteError(op, res) };
}

async function applyRegistry(op) {
    return op.action === "delete" ? regDelete(op) : regSet(op, op.valueType, op.value);
}

async function restoreRegistry(op, prev) {
    if (!prev || prev.readFailed) {
        return { ok: false, error: "No captured state for this value — cannot undo safely" };
    }
    // The value did not exist before the tweak: undo means removing it again,
    // not writing some assumed Windows default.
    if (!prev.exists) return regDelete(op);
    return regSet(op, prev.valueType || op.valueType || "REG_SZ", prev.value);
}

function describeRegistry(op) {
    const target = `${regShortPath(op)}\\${op.name === "" ? "(Default)" : op.name}`;
    return op.action === "delete"
        ? `Delete registry value ${target}`
        : `Set registry value ${target} = ${op.value} (${op.valueType})`;
}

// Powers the "now -> after" table in the details dialog. `now` comes from the
// live capture, so the user sees their actual current value, not an assumption.
function explainRegistry(op, cur) {
    const now = !cur || cur.readFailed ? null : cur.exists ? String(cur.value) : "—";
    return {
        kind: "Registry",
        target: `${regShortPath(op)}\\${op.name === "" ? "(Default)" : op.name}`,
        type: op.action === "delete" ? "" : op.valueType,
        now,
        after: op.action === "delete" ? "—" : String(op.value),
    };
}

// ---------------------------------------------------------------------------
// Registry scan — one value, written to every device of a known kind
// ---------------------------------------------------------------------------
//
// A handful of tweaks do not target one registry key but "every USB input
// device", "every playback device", "the graphics card". The key names contain
// hardware ids, so they cannot be written down in advance.
//
// The dangerous way to do that is to let a data file carry a path to enumerate.
// It does not: a tweak names a setting from the table below, and the table
// decides both which fixed enumeration runs and which single value it may
// write. Paths come back from the scan, and every one is checked against the
// root its scope is allowed to touch before a write happens.
//
// The payoff over the PowerShell one-liners these replace is undo. Those wrote
// the same value everywhere and kept nothing; here each key's previous value is
// captured separately, so undo puts back what each device actually had —
// including deleting the value again on the devices that never had it.

const SCAN_SCOPES = {
    usbInput: { root: "SYSTEM\\CurrentControlSet\\Enum\\USB", label: "USB keyboards and mice" },
    usbController: { root: "SYSTEM\\CurrentControlSet\\Enum\\USB", label: "USB game controllers" },
    bluetooth: { root: "SYSTEM\\CurrentControlSet\\Enum", label: "Bluetooth devices" },
    gpu: { root: "SYSTEM\\CurrentControlSet\\Enum", label: "graphics adapters" },
    audioRender: {
        root: "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render",
        label: "playback devices",
    },
    tcpInterfaces: {
        root: "SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces",
        label: "network interfaces",
    },
};

// `sub` is the subkey under each enumerated device key; "" means the key itself.
// `create: true` allows the subkey to be created when a device does not have it
// yet — only where Windows itself treats the key as optional.
const SCAN_SETTINGS = {
    usbInputEpm: {
        scope: "usbInput",
        sub: "Device Parameters",
        name: "EnhancedPowerManagementEnabled",
        label: "Enhanced power management",
    },
    usbInputSuspend: {
        scope: "usbInput",
        sub: "Device Parameters",
        name: "SelectiveSuspendEnabled",
        label: "Selective suspend",
    },
    usbControllerEpm: {
        scope: "usbController",
        sub: "Device Parameters",
        name: "EnhancedPowerManagementEnabled",
        label: "Enhanced power management",
    },
    usbControllerSuspend: {
        scope: "usbController",
        sub: "Device Parameters",
        name: "SelectiveSuspendEnabled",
        label: "Selective suspend",
    },
    btEpm: {
        scope: "bluetooth",
        sub: "Device Parameters",
        name: "EnhancedPowerManagementEnabled",
        label: "Enhanced power management",
    },
    gpuMsi: {
        scope: "gpu",
        sub: "Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties",
        name: "MSISupported",
        label: "Message-signalled interrupts",
    },
    audioFxDisable: {
        scope: "audioRender",
        sub: "FxProperties",
        name: "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5",
        label: "Audio enhancements disabled",
        create: true,
    },
    audioExclusive: {
        scope: "audioRender",
        sub: "Properties",
        name: "{b3f8fa53-0004-438e-9003-51a46e139bfc},3",
        label: "Applications may take exclusive control",
    },
    tcpAckFrequency: {
        scope: "tcpInterfaces",
        sub: "",
        name: "TcpAckFrequency",
        label: "TCP acknowledgement delay",
    },
    tcpNoDelay: { scope: "tcpInterfaces", sub: "", name: "TCPNoDelay", label: "Nagle's algorithm" },
};

function validateRegistryScan(op) {
    const setting = SCAN_SETTINGS[op.setting];
    if (!setting) throw new Error(`Unknown device setting: ${op.setting}`);
    const raw = op.value;
    const value =
        typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new Error(`Invalid device setting value: ${op.value}`);
    return { ...op, setting: op.setting, value: String(value) };
}

// The scan reads paths off the machine, and this operation then writes to them.
// Confining them to the scope's own root is what keeps a surprising registry
// layout from turning into a write somewhere else entirely.
function scanKeyAllowed(scope, key) {
    const root = SCAN_SCOPES[scope].root.toLowerCase();
    const k = String(key || "").toLowerCase();
    return (k === root || k.startsWith(root + "\\")) && !k.includes("..");
}

const scanTargetKey = (setting, deviceKey) =>
    setting.sub ? `${deviceKey}\\${setting.sub}` : deviceKey;

// A synthetic registry op, so the value writing, deleting and error reporting
// below is the same code the plain `registry` type uses.
const scanRegOp = (setting, key) => ({ hive: "HKLM", key, name: setting.name });

async function captureRegistryScan(ops) {
    const out = new Map();
    if (!ops.length) return out;

    const scopes = [...new Set(ops.map((op) => SCAN_SETTINGS[op.setting].scope))];
    const scan = await runPsJson(path.join(PS_DIR, "scan-registry.ps1"), { scopes }, null);
    if (!scan.ok || !scan.data) {
        const error = scan.error || "device scan failed";
        for (const op of ops) out.set(op, { readFailed: true, error });
        return out;
    }

    // Every value across every op in one read, rather than one PowerShell start
    // per device.
    const reads = [];
    for (const op of ops) {
        const setting = SCAN_SETTINGS[op.setting];
        const found = scan.data[setting.scope];
        if (!found || !found.ok) {
            out.set(op, {
                readFailed: true,
                error: `Could not enumerate ${SCAN_SCOPES[setting.scope].label}`,
            });
            continue;
        }
        const targets = (found.keys || [])
            .filter((k) => scanKeyAllowed(setting.scope, k))
            .map((k) => ({ key: scanTargetKey(setting, k) }));
        out.set(op, { readFailed: false, targets });
        for (const t of targets) reads.push({ target: t, path: `${HIVES.HKLM.provider}\\${t.key}`, name: setting.name });
    }

    if (!reads.length) return out;

    const res = await runPsJson(
        path.join(PS_DIR, "read-registry.ps1"),
        reads.map((r, idx) => ({ id: String(idx), path: r.path, name: r.name })),
        {}
    );
    for (let i = 0; i < reads.length; i++) {
        const raw = res.data ? res.data[String(i)] : null;
        if (!res.ok || !raw) {
            Object.assign(reads[i].target, { readFailed: true });
        } else {
            Object.assign(reads[i].target, {
                readFailed: false,
                exists: !!raw.exists,
                valueType: KIND_TO_REG[raw.type] || raw.type || "",
                value: raw.value,
            });
        }
    }
    return out;
}

function registryScanIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    // No device of this kind on this machine. Nothing to change is the end state
    // the tweak asks for, the same answer a service that was never installed
    // gets — anything else would recommend a Bluetooth tweak on a PC without
    // Bluetooth, forever.
    if (!cur.targets.length) return true;
    if (cur.targets.some((t) => t.readFailed)) return null;
    const want = normalizeRegValue("REG_DWORD", op.value);
    return cur.targets.every((t) => t.exists && normalizeRegValue("REG_DWORD", t.value) === want);
}

async function applyRegistryScan(op, prev) {
    const setting = SCAN_SETTINGS[op.setting];
    if (!prev || prev.readFailed) {
        return { ok: false, error: prev && prev.error ? prev.error : "Could not read the current state" };
    }
    if (!prev.targets.length) {
        return { ok: true, warning: `No ${SCAN_SCOPES[setting.scope].label} found — nothing to change` };
    }

    const failures = [];
    for (const t of prev.targets) {
        // Writing where nothing was read is how an undo loses a value. The one
        // exception is a subkey Windows leaves out until something needs it.
        if (t.readFailed && !setting.create) {
            failures.push("could not be read before the change");
            continue;
        }
        const res = await regSet(scanRegOp(setting, t.key), "REG_DWORD", op.value);
        if (!res.ok) failures.push(res.error);
    }
    if (!failures.length) return { ok: true };
    if (failures.length === prev.targets.length) return { ok: false, error: failures[0] };
    return {
        ok: true,
        warning: `${prev.targets.length - failures.length} of ${prev.targets.length} devices changed; the rest failed: ${failures[0]}`,
    };
}

async function restoreRegistryScan(op, prev) {
    const setting = SCAN_SETTINGS[op.setting];
    if (!prev || prev.readFailed) {
        return { ok: false, error: "No captured state for these devices — cannot undo safely" };
    }
    if (!prev.targets.length) return { ok: true };

    const failures = [];
    for (const t of prev.targets) {
        if (t.readFailed) {
            failures.push("no captured value");
            continue;
        }
        const regOp = scanRegOp(setting, t.key);
        // Each device gets its own value back, and a device that never had the
        // value has it removed rather than set to some assumed default.
        const res = t.exists ? await regSet(regOp, t.valueType || "REG_DWORD", t.value) : await regDelete(regOp);
        if (!res.ok) failures.push(res.error);
    }
    return failures.length ? { ok: false, error: `${failures.length} of ${prev.targets.length} devices: ${failures[0]}` } : { ok: true };
}

function describeRegistryScan(op) {
    const setting = SCAN_SETTINGS[op.setting];
    return `Set "${setting.name}" = ${op.value} on every one of the ${SCAN_SCOPES[setting.scope].label} found on this PC`;
}

function explainRegistryScan(op, cur) {
    const setting = SCAN_SETTINGS[op.setting];
    let now = null;
    if (cur && !cur.readFailed) {
        const n = cur.targets.length;
        if (!n) {
            now = "no such devices on this PC";
        } else {
            const want = normalizeRegValue("REG_DWORD", op.value);
            const set = cur.targets.filter((t) => !t.readFailed && t.exists && normalizeRegValue("REG_DWORD", t.value) === want).length;
            now = `${set} of ${n} already set`;
        }
    }
    return {
        kind: "Every device of a kind",
        target: `${setting.label} — ${SCAN_SCOPES[setting.scope].label}`,
        type: "REG_DWORD",
        now,
        after: String(op.value),
    };
}

// ---------------------------------------------------------------------------
// Per-application — settings Windows keeps against one executable
// ---------------------------------------------------------------------------
//
// These are the only tweaks that can honestly differ between games. Everything
// else in the catalogue is machine-wide, which is why two game presets built
// from it come out 98% identical.
//
// Windows stores three useful things against an executable: which GPU it runs
// on, whether the fullscreen compositor is bypassed, and what CPU priority it
// starts at. All three are registry writes keyed by the program's path or file
// name, so the path has to be discovered on this machine.
//
// A tweak names an app and a setting, both from the tables below. The candidate
// paths are fixed strings here, with environment variables expanded at read
// time — a data file still cannot describe a location on disk.

const APPS = {
    // The Retrac launcher installs to Program Files; the client itself is
    // dropped next to the anti-cheat rather than under the launcher.
    retrac: {
        label: "Project Retrac",
        // The client is dropped next to the anti-cheat rather than under the
        // launcher, and the launcher's registered install location does not
        // point at it. The anti-cheat service records its own path though, so
        // that is asked first: it survives an install on another drive, which
        // guessing at Program Files does not.
        fromService: { name: "AleaAntiCheat", exe: "FortniteClient-Win64-Shipping.exe" },
        candidates: [
            "%ProgramFiles%\\Alea\\FortniteClient-Win64-Shipping.exe",
            "%ProgramFiles(x86)%\\Alea\\FortniteClient-Win64-Shipping.exe",
        ],
    },
    fortnite: {
        label: "Fortnite",
        candidates: [
            "%ProgramFiles%\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe",
        ],
    },
    obs: {
        label: "OBS Studio",
        candidates: [
            "%ProgramFiles%\\obs-studio\\bin\\64bit\\obs64.exe",
            "%ProgramFiles(x86)%\\obs-studio\\bin\\64bit\\obs64.exe",
        ],
    },
};

// `kind` decides how the value is read and written:
//   list  — a ";"-separated list of key=value settings, keyed by full path
//   flags — a space-separated set of tokens, keyed by full path
//   dword — a plain number under Image File Execution Options, keyed by file name
const APP_SETTINGS = {
    gpuHighPerf: {
        kind: "list",
        hive: "HKCU",
        key: "Software\\Microsoft\\DirectX\\UserGpuPreferences",
        token: "GpuPreference=2",
        prefix: "GpuPreference=",
        label: "Run on the high-performance GPU",
    },
    fullscreenOptOff: {
        kind: "flags",
        hive: "HKCU",
        key: "Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers",
        token: "DISABLEDXMAXIMIZEDWINDOWEDMODE",
        label: "Fullscreen optimizations off",
    },
    cpuPriorityHigh: {
        kind: "dword",
        hive: "HKLM",
        key: "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options",
        sub: "PerfOptions",
        name: "CpuPriorityClass",
        value: "3", // 3 = High. 4 would be Realtime, which starves the OS.
        label: "Start at high CPU priority",
    },
};

function validatePerApp(op) {
    if (!Object.prototype.hasOwnProperty.call(APPS, String(op.app || "")))
        throw new Error(`Unknown application: ${op.app}`);
    if (!Object.prototype.hasOwnProperty.call(APP_SETTINGS, String(op.setting || "")))
        throw new Error(`Unknown per-application setting: ${op.setting}`);
    return { ...op, app: String(op.app), setting: String(op.setting) };
}

// Asks a Windows service where it lives and looks for the executable in the
// same folder. Reading only — and only the ImagePath of a service named in the
// table above, never one supplied by a tweak.
function exeFromService(spec) {
    try {
        const out = require("child_process")
            .execFileSync(
                "reg.exe",
                ["query", `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${spec.name}`, "/v", "ImagePath"],
                { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
            )
            .toString();
        const m = /ImagePath\s+REG_[A-Z_]+\s+(.+)/i.exec(out);
        if (!m) return null;
        // The value is usually quoted and may carry arguments.
        const image = m[1].trim().replace(/^"(.*?)"/, "$1").split(/"\s|\s-|\s\//)[0].trim().replace(/^"|"$/g, "");
        const candidate = path.join(path.dirname(image), spec.exe);
        return fs.statSync(candidate).isFile() ? candidate : null;
    } catch {
        return null;
    }
}

// Expands %VARS% and returns the first candidate that is actually on disk.
function findExe(appId) {
    const app = APPS[appId];
    if (app.fromService) {
        const found = exeFromService(app.fromService);
        if (found) return found;
    }
    for (const raw of APPS[appId].candidates) {
        const full = raw.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
        if (full.includes("%")) continue; // a variable this system does not define
        try {
            if (fs.statSync(full).isFile()) return full;
        } catch {
            /* next candidate */
        }
    }
    return null;
}

// Where the setting lives for this executable: a value name on a shared key, or
// a value inside a per-executable subkey.
function perAppTarget(setting, exe) {
    if (setting.kind === "dword") {
        return { hive: setting.hive, key: `${setting.key}\\${path.basename(exe)}\\${setting.sub}`, name: setting.name };
    }
    return { hive: setting.hive, key: setting.key, name: exe };
}

const splitList = (s, kind) => String(s || "").split(kind === "flags" ? /\s+/ : /;/).filter(Boolean);

function perAppHasToken(setting, value) {
    if (value === null || value === undefined) return false;
    if (setting.kind === "dword") return normalizeRegValue("REG_DWORD", value) === setting.value;
    return splitList(value, setting.kind).some((t) => t.trim() === setting.token);
}

// Adds the token without discarding anything else already there. Windows writes
// its own entries into both of these lists, and replacing the whole string would
// quietly drop another program's setting.
function perAppWithToken(setting, current) {
    if (setting.kind === "dword") return setting.value;
    const parts = splitList(current, setting.kind).map((t) => t.trim());
    const kept = setting.prefix ? parts.filter((t) => !t.startsWith(setting.prefix)) : parts.filter((t) => t !== setting.token);
    kept.push(setting.token);
    return setting.kind === "flags" ? `~ ${kept.filter((t) => t !== "~").join(" ")}` : kept.join(";") + ";";
}

async function capturePerApp(ops) {
    const out = new Map();
    if (!ops.length) return out;

    const reads = [];
    for (const op of ops) {
        const exe = findExe(op.app);
        if (!exe) {
            out.set(op, { readFailed: false, missing: true });
            continue;
        }
        const setting = APP_SETTINGS[op.setting];
        const target = perAppTarget(setting, exe);
        const state = { readFailed: false, missing: false, exe, target };
        out.set(op, state);
        reads.push({ state, path: `${HIVES[target.hive].provider}\\${target.key}`, name: target.name });
    }
    if (!reads.length) return out;

    const res = await runPsJson(
        path.join(PS_DIR, "read-registry.ps1"),
        reads.map((r, idx) => ({ id: String(idx), path: r.path, name: r.name })),
        {}
    );
    for (let i = 0; i < reads.length; i++) {
        const raw = res.data ? res.data[String(i)] : null;
        if (!res.ok || !raw) {
            Object.assign(reads[i].state, { readFailed: true, error: res.error || "registry read failed" });
        } else {
            Object.assign(reads[i].state, {
                exists: !!raw.exists,
                valueType: KIND_TO_REG[raw.type] || raw.type || "",
                value: raw.value,
            });
        }
    }
    return out;
}

function perAppIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    // The program is not on this PC, so the setting cannot be in place. Saying
    // "applied" would be a lie, and saying "not applied" invites applying it.
    if (cur.missing) return null;
    if (!cur.exists) return false;
    return perAppHasToken(APP_SETTINGS[op.setting], cur.value);
}

const perAppRegOp = (state) => ({ hive: state.target.hive, key: state.target.key, name: state.target.name });

async function applyPerApp(op, prev) {
    const setting = APP_SETTINGS[op.setting];
    if (!prev || prev.readFailed) return { ok: false, error: prev && prev.error ? prev.error : "Could not read the current state" };
    if (prev.missing) return { ok: false, error: `${APPS[op.app].label} is not installed on this PC` };

    const type = setting.kind === "dword" ? "REG_DWORD" : "REG_SZ";
    return regSet(perAppRegOp(prev), type, perAppWithToken(setting, prev.exists ? prev.value : ""));
}

async function restorePerApp(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this program — cannot undo safely" };
    if (prev.missing) return { ok: true };
    const regOp = perAppRegOp(prev);
    // Nothing was there before the tweak, so undo removes it rather than
    // writing a default that Windows never had.
    if (!prev.exists) return regDelete(regOp);
    return regSet(regOp, prev.valueType || (APP_SETTINGS[op.setting].kind === "dword" ? "REG_DWORD" : "REG_SZ"), prev.value);
}

const describePerApp = (op) => `${APP_SETTINGS[op.setting].label} for ${APPS[op.app].label}`;

function explainPerApp(op, cur) {
    const setting = APP_SETTINGS[op.setting];
    let now = null;
    if (cur && !cur.readFailed) {
        if (cur.missing) now = "not installed";
        else if (!cur.exists) now = "—";
        else now = String(cur.value);
    }
    return {
        kind: "Per program",
        target: `${APPS[op.app].label} — ${setting.label}`,
        type: cur && cur.exe ? path.basename(cur.exe) : "",
        now,
        after: setting.kind === "dword" ? setting.value : setting.token,
    };
}

// ---------------------------------------------------------------------------
// Game config — a setting that lives in the game's own ini file
// ---------------------------------------------------------------------------
//
// Some of the biggest wins are not Windows settings at all. Running an old
// DirectX 11 build in borderless windowed mode sends every frame through the
// desktop compositor, which costs a whole frame — about 4 ms at 240 Hz — and no
// registry key can undo that. Only the game's own configuration can.
//
// Same rule as everywhere: a tweak names a game and a setting from the tables
// below, never a file path. Two things make this type more dangerous than a
// registry write, and both are handled here:
//
//   - The file belongs to someone else. Unreal keeps hundreds of unrelated
//     lines in it, so the edit is surgical: find the key inside its section,
//     replace that one line, leave every byte around it alone, including the
//     CRLF line endings Unreal writes.
//
//   - The game rewrites the file when it exits. Editing while it runs achieves
//     nothing and looks like a failure that is really a race, so applying is
//     refused while the process is alive.

const GAME_CONFIGS = {
    retrac: {
        label: "Project Retrac",
        file: "%LOCALAPPDATA%\\RetracGame\\Saved\\Config\\WindowsClient\\GameUserSettings.ini",
        process: "FortniteClient-Win64-Shipping.exe",
    },
};

const GAME_SETTINGS = {
    exclusiveFullscreen: {
        section: "/Script/FortniteGame.FortGameUserSettings",
        // Unreal keeps a second "last confirmed" copy and reverts to it when the
        // two disagree, which is why setting only the first one does not hold —
        // the same shape of bug as Game Mode.
        entries: { PreferredFullscreenMode: "0", LastConfirmedFullscreenMode: "0" },
        label: "Exclusive fullscreen instead of borderless",
    },
};

function validateGameConfig(op) {
    if (!Object.prototype.hasOwnProperty.call(GAME_CONFIGS, String(op.game || "")))
        throw new Error(`Unknown game: ${op.game}`);
    if (!Object.prototype.hasOwnProperty.call(GAME_SETTINGS, String(op.setting || "")))
        throw new Error(`Unknown game setting: ${op.setting}`);
    return { ...op, game: String(op.game), setting: String(op.setting) };
}

const gameConfigPath = (gameId) => {
    const full = GAME_CONFIGS[gameId].file.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
    return full.includes("%") ? null : full;
};

function gameIsRunning(gameId) {
    try {
        const out = require("child_process")
            .execFileSync("tasklist.exe", ["/fi", `imagename eq ${GAME_CONFIGS[gameId].process}`, "/nh"], {
                windowsHide: true,
            })
            .toString();
        return out.includes(GAME_CONFIGS[gameId].process);
    } catch {
        return false; // tasklist unavailable is not a reason to refuse
    }
}

// Reads one key from inside one section. Returns null when the section or the
// key is absent, which is different from an empty value.
function iniRead(text, section, key) {
    const lines = text.split(/\r?\n/);
    let inSection = false;
    for (const line of lines) {
        const head = /^\s*\[(.+?)\]\s*$/.exec(line);
        if (head) {
            inSection = head[1] === section;
            continue;
        }
        if (!inSection) continue;
        const m = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=(.*)$`).exec(line);
        if (m) return m[1].trim();
    }
    return null;
}

// Replaces the value of one key in place. A key that is not there yet is added
// directly under its section header. Everything else in the file is untouched,
// and the file's own line ending is kept.
function iniWrite(text, section, key, value) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let inSection = false;
    let sectionAt = -1;
    for (let i = 0; i < lines.length; i++) {
        const head = /^\s*\[(.+?)\]\s*$/.exec(lines[i]);
        if (head) {
            if (head[1] === section) {
                inSection = true;
                sectionAt = i;
            } else if (inSection) {
                break; // left the section without finding the key
            }
            continue;
        }
        if (inSection && new RegExp(`^\\s*${esc}\\s*=`).test(lines[i])) {
            lines[i] = `${key}=${value}`;
            return lines.join(eol);
        }
    }
    if (sectionAt < 0) return null; // the section does not exist; do not invent one
    lines.splice(sectionAt + 1, 0, `${key}=${value}`);
    return lines.join(eol);
}

async function captureGameConfig(ops) {
    const out = new Map();
    for (const op of ops) {
        const file = gameConfigPath(op.game);
        if (!file || !fs.existsSync(file)) {
            out.set(op, { readFailed: false, missing: true });
            continue;
        }
        try {
            const text = fs.readFileSync(file, "utf8");
            const setting = GAME_SETTINGS[op.setting];
            const previous = {};
            for (const key of Object.keys(setting.entries)) previous[key] = iniRead(text, setting.section, key);
            out.set(op, { readFailed: false, missing: false, file, previous });
        } catch (e) {
            out.set(op, { readFailed: true, error: `Could not read ${path.basename(file)}: ${e.message}` });
        }
    }
    return out;
}

function gameConfigIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    if (cur.missing) return null; // the game is not installed here
    const setting = GAME_SETTINGS[op.setting];
    return Object.entries(setting.entries).every(([k, v]) => String(cur.previous[k]) === String(v));
}

function writeGameConfig(op, prev, values) {
    const setting = GAME_SETTINGS[op.setting];
    let text;
    try {
        text = fs.readFileSync(prev.file, "utf8");
    } catch (e) {
        return { ok: false, error: `Could not read the configuration: ${e.message}` };
    }
    for (const [key, value] of Object.entries(values)) {
        if (value === null) continue; // was not in the file before; leave it out
        const next = iniWrite(text, setting.section, key, value);
        if (next === null) return { ok: false, error: `Section [${setting.section}] is not in this configuration` };
        text = next;
    }
    try {
        fs.writeFileSync(prev.file, text, "utf8");
    } catch (e) {
        return { ok: false, error: `Could not write the configuration: ${e.message}` };
    }
    return { ok: true };
}

async function applyGameConfig(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: prev && prev.error ? prev.error : "Could not read the configuration" };
    if (prev.missing) return { ok: false, error: `${GAME_CONFIGS[op.game].label} is not installed on this PC` };
    if (gameIsRunning(op.game)) {
        return {
            ok: false,
            error: `${GAME_CONFIGS[op.game].label} is running. It rewrites this file when it closes, so the change would be lost — close the game and apply again.`,
        };
    }
    return writeGameConfig(op, prev, GAME_SETTINGS[op.setting].entries);
}

async function restoreGameConfig(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this configuration — cannot undo safely" };
    if (prev.missing) return { ok: true };
    if (gameIsRunning(op.game)) {
        return { ok: false, error: `${GAME_CONFIGS[op.game].label} is running — close it and undo again.` };
    }
    return writeGameConfig(op, prev, prev.previous);
}

const describeGameConfig = (op) =>
    `${GAME_SETTINGS[op.setting].label} in ${GAME_CONFIGS[op.game].label}'s own settings file`;

function explainGameConfig(op, cur) {
    const setting = GAME_SETTINGS[op.setting];
    const keys = Object.keys(setting.entries);
    let now = null;
    if (cur && !cur.readFailed) {
        now = cur.missing ? "not installed" : keys.map((k) => `${k}=${cur.previous[k] === null ? "—" : cur.previous[k]}`).join("  ");
    }
    return {
        kind: "Game setting",
        target: `${GAME_CONFIGS[op.game].label} — ${setting.label}`,
        type: "GameUserSettings.ini",
        now,
        after: keys.map((k) => `${k}=${setting.entries[k]}`).join("  "),
    };
}

// ---------------------------------------------------------------------------
// Toggle — a Windows switch that lives inside a tool, not in the registry
// ---------------------------------------------------------------------------
//
// Memory compression and reserved storage have no registry value to write: a
// cmdlet holds the state and a cmdlet changes it. Shipping them as `command`
// would have cost both halves that make a tweak behave — there would be no way
// to tell whether it is already on, so it would sit in the recommended list
// forever, and no way back.
//
// Same rule as everywhere else: the operation names an entry in this table, and
// the table owns the argument lists.

const TOGGLES = {
    memoryCompression: {
        label: "Memory compression",
        on: ["-NoProfile", "-NonInteractive", "-Command", "Enable-MMAgent -mc"],
        off: ["-NoProfile", "-NonInteractive", "-Command", "Disable-MMAgent -mc"],
        file: "powershell.exe",
    },
    reservedStorage: {
        label: "Reserved storage",
        file: "dism.exe",
        on: ["/Online", "/Set-ReservedStorageState", "/State:Enabled"],
        off: ["/Online", "/Set-ReservedStorageState", "/State:Disabled"],
        // DISM refuses while an update is mid-flight, and says so.
        timeout: 300_000,
    },
};

function validateToggle(op) {
    if (!Object.prototype.hasOwnProperty.call(TOGGLES, String(op.setting || "")))
        throw new Error(`Unknown Windows toggle: ${op.setting}`);
    if (typeof op.enabled !== "boolean")
        throw new Error(`Toggle "${op.setting}" needs enabled: true or false, got ${JSON.stringify(op.enabled)}`);
    return { ...op, setting: String(op.setting), enabled: op.enabled };
}

async function captureToggles(ops) {
    const out = new Map();
    if (!ops.length) return out;
    const settings = [...new Set(ops.map((op) => op.setting))];
    const res = await runPsJson(path.join(PS_DIR, "read-toggles.ps1"), { settings }, null);
    for (const op of ops) {
        const raw = res.ok && res.data ? res.data[op.setting] : null;
        if (!raw || !raw.ok) {
            // Reading these needs administrator rights, so an unelevated run
            // lands here. Unknown, not "switched off".
            out.set(op, {
                readFailed: true,
                error: res.error || `Could not read "${TOGGLES[op.setting].label}" — this needs administrator rights`,
            });
        } else {
            out.set(op, { readFailed: false, enabled: !!raw.enabled });
        }
    }
    return out;
}

function toggleIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    return cur.enabled === op.enabled;
}

async function setToggle(setting, enabled) {
    const spec = TOGGLES[setting];
    const res = await run(spec.file, enabled ? spec.on : spec.off, { timeout: spec.timeout || 120_000 });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.stderr || res.stdout || res.error || `${spec.file} exited ${res.code}` };
}

async function applyToggle(op, prev) {
    if (!prev || prev.readFailed) {
        return { ok: false, error: prev && prev.error ? prev.error : "Could not read the current state" };
    }
    return setToggle(op.setting, op.enabled);
}

async function restoreToggle(op, prev) {
    if (!prev || prev.readFailed) {
        return { ok: false, error: `No captured state for "${TOGGLES[op.setting].label}" — cannot undo safely` };
    }
    return setToggle(op.setting, prev.enabled);
}

const describeToggle = (op) => `Turn ${TOGGLES[op.setting].label} ${op.enabled ? "on" : "off"}`;

const explainToggle = (op, cur) => ({
    kind: "Windows setting",
    target: TOGGLES[op.setting].label,
    type: "",
    now: cur && !cur.readFailed ? (cur.enabled ? "On" : "Off") : null,
    after: op.enabled ? "On" : "Off",
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const SERVICE_NAME_RE = /^[A-Za-z0-9_.\-]{1,80}$/;
const START_MODES = new Set(["auto", "delayed-auto", "manual", "disabled"]);
// CIM reports StartMode with these spellings; sc.exe expects the ones on the right.
const CIM_TO_SC = { Boot: "boot", System: "system", Auto: "auto", Manual: "demand", Disabled: "disabled" };

function validateService(op) {
    const name = String(op.name || "");
    if (!SERVICE_NAME_RE.test(name)) throw new Error(`Invalid service name: ${op.name}`);
    const startMode = String(op.startMode || "").toLowerCase();
    if (!START_MODES.has(startMode)) throw new Error(`Invalid service start mode: ${op.startMode}`);
    // stop defaults on (a tweak disables things); start is opt-in, because only
    // a repair wants the service running again right now.
    return { ...op, name, startMode, stop: op.stop !== false, start: op.start === true };
}

async function captureServices(ops) {
    if (!ops.length) return new Map();
    const names = [...new Set(ops.map((o) => o.name))];
    const res = await runPsJson(path.join(PS_DIR, "read-services.ps1"), names, {});
    const out = new Map();
    for (const op of ops) {
        const raw = res.data ? res.data[op.name] : null;
        if (!res.ok || !raw) {
            out.set(op, { readFailed: true, error: res.error || "service read failed" });
        } else {
            out.set(op, {
                exists: !!raw.exists,
                startMode: raw.startMode || "",
                state: raw.state || "",
                display: raw.display || "",
            });
        }
    }
    return out;
}

function serviceIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    if (!cur.exists) {
        // Not present on this edition. Asked to disable it, that is the state
        // being asked for and saying so is what lets the tweak leave the
        // recommended list - "unknown" kept Fax on screen for ever on machines
        // that never had Fax. Asked to turn one ON, absence is the opposite of
        // satisfied and there is nothing here to enable, so the verdict stays
        // "cannot tell" rather than becoming a false yes.
        return op.startMode === "disabled" ? true : null;
    }
    const want = op.startMode === "delayed-auto" ? "auto" : op.startMode;
    return String(cur.startMode || "").toLowerCase() === want;
}

async function scConfig(name, scStartType) {
    // "start=" must keep its trailing equals sign as its own argument — that is
    // sc.exe's own syntax, not a quoting mistake.
    const res = await run("sc.exe", ["config", name, "start=", scStartType]);
    return res.ok
        ? { ok: true }
        : { ok: false, error: res.stderr || res.stdout || `sc config exited ${res.code}` };
}

// `prev` is the state captured immediately before this write. It is optional
// only because the appx and autostart paths share the apply loop without one.
async function applyService(op, prev) {
    // A service this edition of Windows never installed is not a failure, and
    // sc.exe saying so ("error 1060") is not news. Reporting it as one put the
    // tweak in a loop nobody could get out of: the card stayed selectable
    // because serviceIsApplied answers "unknown" for a service that is absent,
    // so the next apply failed exactly the same way, for ever. Absent is the
    // state being asked for - a service that does not exist cannot run.
    if (prev && !prev.readFailed && prev.exists === false) {
        return { ok: true, warning: `Service "${op.name}" is not installed on this system - nothing to change` };
    }
    const scType = op.startMode === "manual" ? "demand" : op.startMode;
    const cfg = await scConfig(op.name, scType);
    if (!cfg.ok) return cfg;
    if (op.stop && op.startMode === "disabled") {
        // A stop failure is not fatal: the start type is already changed, so the
        // service stays down after the next reboot.
        const stopped = await run("sc.exe", ["stop", op.name]);
        if (!stopped.ok && !/1062|1061/.test(stopped.stdout + stopped.stderr)) {
            return { ok: true, warning: `Start type changed, but the service could not be stopped now` };
        }
    }
    if (op.start && op.startMode !== "disabled") {
        // 1056 is "already running", which is the state being asked for.
        const started = await run("sc.exe", ["start", op.name]);
        if (!started.ok && !/1056/.test(started.stdout + started.stderr)) {
            return { ok: true, warning: "Start type changed, but the service did not start now" };
        }
    }
    return { ok: true };
}

async function restoreService(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this service" };
    if (!prev.exists) return { ok: true };
    const scType = CIM_TO_SC[prev.startMode] || "demand";
    const cfg = await scConfig(op.name, scType);
    if (!cfg.ok) return cfg;
    if (prev.state === "Running") {
        const started = await run("sc.exe", ["start", op.name]);
        if (!started.ok && !/1056/.test(started.stdout + started.stderr)) {
            return { ok: true, warning: "Start type restored, but the service did not start again" };
        }
    }
    return { ok: true };
}

function describeService(op) {
    const after = op.stop && op.startMode === "disabled" ? " and stop it" : op.start ? " and start it" : "";
    return `Set service "${op.name}" start type to ${op.startMode}${after}`;
}

function explainService(op, cur) {
    let now = null;
    if (cur && !cur.readFailed) now = cur.exists ? `${cur.startMode} · ${cur.state}` : "not installed";
    return { kind: "Service", target: cur?.display || op.name, type: "", now, after: op.startMode };
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

const TASK_PATH_RE = /^\\[^\r\n"|<>*?]{1,240}$/;

function validateTask(op) {
    const taskPath = String(op.path || "");
    if (!TASK_PATH_RE.test(taskPath)) throw new Error(`Invalid scheduled task path: ${op.path}`);
    return { ...op, path: taskPath, enabled: op.enabled === true };
}

async function captureTasks(ops) {
    if (!ops.length) return new Map();
    const input = [...new Set(ops.map((o) => o.path))];
    const res = await runPsJson(path.join(PS_DIR, "read-tasks.ps1"), input, {});
    const out = new Map();
    for (const op of ops) {
        const raw = res.data ? res.data[op.path] : null;
        if (!res.ok || !raw) out.set(op, { readFailed: true, error: res.error || "task read failed" });
        else out.set(op, { exists: !!raw.exists, enabled: !!raw.enabled });
    }
    return out;
}

function taskIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    if (!cur.exists) return null;
    return cur.enabled === op.enabled;
}

async function setTaskEnabled(taskPath, enabled) {
    const res = await run("schtasks.exe", [
        "/Change",
        "/TN",
        taskPath,
        enabled ? "/ENABLE" : "/DISABLE",
    ]);
    return res.ok
        ? { ok: true }
        : { ok: false, error: res.stderr || res.stdout || `schtasks exited ${res.code}` };
}

const applyTask = (op) => setTaskEnabled(op.path, op.enabled);

async function restoreTask(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this task" };
    if (!prev.exists) return { ok: true };
    return setTaskEnabled(op.path, prev.enabled);
}

const describeTask = (op) => `${op.enabled ? "Enable" : "Disable"} scheduled task ${op.path}`;

function explainTask(op, cur) {
    let now = null;
    if (cur && !cur.readFailed) now = cur.exists ? (cur.enabled ? "Enabled" : "Disabled") : "not present";
    return {
        kind: "Scheduled task",
        target: op.path,
        type: "",
        now,
        after: op.enabled ? "Enabled" : "Disabled",
    };
}

// ---------------------------------------------------------------------------
// Store apps (Appx)
// ---------------------------------------------------------------------------

const APPX_NAME_RE = /^[A-Za-z0-9_.\-]{1,120}$/;

// Removing any of these breaks Windows in ways the user cannot easily repair —
// the Store itself, the runtimes other apps link against, the shell, the sign-in
// broker and the Defender UI. Enforced here rather than only in the catalogue,
// so no future data file can talk the app into removing one.
const NEVER_REMOVE = [
    /^Microsoft\.WindowsStore$/i,
    /^Microsoft\.DesktopAppInstaller$/i,
    /^Microsoft\.VCLibs\./i,
    /^Microsoft\.NET\.Native\./i,
    /^Microsoft\.UI\.Xaml\./i,
    /^Microsoft\.SecHealthUI$/i,
    /^Microsoft\.Windows\.ShellExperienceHost$/i,
    /^Microsoft\.Windows\.StartMenuExperienceHost$/i,
    /^Microsoft\.AAD\.BrokerPlugin$/i,
    /^Microsoft\.AccountsControl$/i,
    /^Microsoft\.Windows\.Search$/i,
    /^Microsoft\.WindowsAppRuntime\./i,
];

const isProtectedPackage = (name) => NEVER_REMOVE.some((re) => re.test(name));

function validateAppx(op) {
    const name = String(op.package || op.name || "");
    if (!APPX_NAME_RE.test(name)) throw new Error(`Invalid package name: ${op.package}`);
    if (isProtectedPackage(name)) {
        throw new Error(`"${name}" is system-critical and can never be removed by Panda Tweaks`);
    }
    return { ...op, package: name };
}

// op.package is an exact, already-resolved package name. Pattern matching
// happens in resolveAppxPatterns, never at removal time.
async function captureAppx(ops) {
    if (!ops.length) return new Map();
    const patterns = [...new Set(ops.map((o) => o.package))];
    const res = await runPsJson(path.join(PS_DIR, "appx.ps1"), { action: "list", patterns }, {});
    const out = new Map();
    for (const op of ops) {
        const raw = res.data ? res.data[op.package] : null;
        if (!res.ok || !raw) out.set(op, { readFailed: true, error: res.error || "appx read failed" });
        else out.set(op, { installed: !!raw.installed, names: raw.names || [] });
    }
    return out;
}

// Every removable package on this machine, whether or not the catalogue knows
// it. Protected packages are returned *marked*, not dropped — a package that is
// there but must not be touched is a different fact from one that is absent, and
// the UI has to be able to say which.
async function listInstalledApps() {
    const res = await runPsJson(path.join(PS_DIR, "appx.ps1"), { action: "installed" }, {});
    const apps = res.data && Array.isArray(res.data.apps) ? res.data.apps : null;
    if (!res.ok || !apps) return { ok: false, error: res.error || "Could not read installed packages", apps: [] };
    return {
        ok: true,
        error: null,
        apps: apps
            .filter((a) => a && APPX_NAME_RE.test(String(a.name || "")))
            .map((a) => ({
                package: String(a.name),
                fullName: String(a.fullName || ""),
                publisher: String(a.publisher || ""),
                version: String(a.version || ""),
                protected: isProtectedPackage(String(a.name)),
            })),
    };
}

function appxIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    return !cur.installed; // "applied" means the package is gone
}

async function applyAppx(op) {
    if (isProtectedPackage(op.package)) {
        return { ok: false, error: `"${op.package}" is system-critical and will not be removed` };
    }
    const res = await runPsJson(path.join(PS_DIR, "appx.ps1"), { action: "remove", names: [op.package] }, {});
    const raw = res.data ? res.data[op.package] : null;
    if (!res.ok || !raw) return { ok: false, error: res.error || "Removal produced no result" };
    if (raw.removed) return { ok: true, detail: { removed: op.package } };
    return { ok: false, error: raw.error || "The package could not be removed" };
}

// Removing a Store app the per-user way leaves the files on disk, so putting it
// back is often just a re-registration — no download, no Store, no account. It
// is not guaranteed: the payload can be gone, and reading it needs elevation.
// So this attempts the real thing and reports precisely which of those it hit,
// rather than either refusing outright or claiming a clean undo.
async function restoreAppx(op) {
    const res = await runPsJson(path.join(PS_DIR, "appx.ps1"), { action: "register", names: [op.package] }, {});
    const raw = res.data ? res.data[op.package] : null;
    if (!res.ok || !raw) return { ok: false, error: res.error || "Restoring produced no result" };
    if (raw.ok) return { ok: true, detail: { restored: op.package, how: raw.reason } };

    const reason =
        {
            "needs-admin": `Putting "${op.package}" back needs administrator rights: its files live in a folder a standard user cannot read.`,
            "no-payload": `"${op.package}" is no longer on this machine. Install it again from the Microsoft Store.`,
        }[raw.reason] || raw.error || `"${op.package}" could not be registered again`;
    return { ok: false, error: reason };
}

const describeAppx = (op) => `Remove Store app package "${op.package}" for the current user`;

const explainAppx = (op, cur) => ({
    kind: "Store app",
    target: op.package,
    type: "",
    now: !cur || cur.readFailed ? null : cur.installed ? "installed" : "not installed",
    after: "removed",
});

// ---------------------------------------------------------------------------
// Repair commands
// ---------------------------------------------------------------------------

// The repair actions Windows offers have no state to capture and no undo: they
// re-run a built-in tool. That is still not a reason to hand a command string
// through the data files.
//
// A command operation names an ENTRY IN THIS TABLE. The file and its arguments
// live here as a fixed argv array; a data file, and therefore anything the
// renderer can reach, can only choose an id. There is still no path by which a
// string becomes a command line, which is the property that matters while the
// process may be elevated.
const COMMANDS = {
    flushDns: { file: "ipconfig.exe", args: ["/flushdns"], admin: false, label: "Flush the DNS cache" },
    winsockReset: { file: "netsh.exe", args: ["winsock", "reset"], admin: true, label: "Reset Winsock", restart: true },
    ipReset: { file: "netsh.exe", args: ["int", "ip", "reset"], admin: true, label: "Reset the TCP/IP stack", restart: true },
    tcpAutotuningNormal: {
        file: "netsh.exe",
        args: ["int", "tcp", "set", "global", "autotuninglevel=normal"],
        admin: true,
        label: "Restore TCP auto-tuning to normal",
    },
    storeReset: { file: "wsreset.exe", args: [], admin: false, label: "Reset the Microsoft Store cache", timeout: 300_000 },
    restartExplorer: {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Stop-Process -Name explorer -Force"],
        admin: false,
        // Windows restarts Explorer by itself once it is stopped.
        label: "Restart Explorer",
    },
    // These two walk the whole component store and can run for a long time.
    dismRestoreHealth: {
        file: "dism.exe",
        args: ["/Online", "/Cleanup-Image", "/RestoreHealth"],
        admin: true,
        label: "Repair the Windows component store (DISM)",
        timeout: 45 * 60_000,
    },
    sfcScanNow: {
        file: "sfc.exe",
        args: ["/scannow"],
        admin: true,
        label: "Check and repair system files (SFC)",
        timeout: 45 * 60_000,
    },
    // The four below replace command lines the original import could not
    // translate. Each is a fixed argument list on this list, which is the point:
    // the renderer asks for "rebuildIconCache", never for a shell string, so a
    // compromised or buggy UI still cannot run anything that is not written here.
    // Paths are left unquoted on purpose - PowerShell expands $env: in a bare
    // path, and adding quotes would mean nesting them inside these strings.
    rebuildIconCache: {
        file: "powershell.exe",
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Remove-Item -Force -ErrorAction SilentlyContinue $env:LOCALAPPDATA\\IconCache.db; " +
                "Remove-Item -Force -ErrorAction SilentlyContinue $env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\iconcache_*.db",
        ],
        admin: false,
        // Explorer holds the rebuilt cache in memory, so the new icons appear
        // after it restarts - which the repair page offers separately.
        label: "Delete the icon caches so Explorer rebuilds them",
    },
    clearFontCache: {
        file: "powershell.exe",
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Stop-Service FontCache -Force -ErrorAction SilentlyContinue; " +
                "Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $env:WINDIR\\ServiceProfiles\\LocalService\\AppData\\Local\\FontCache\\*; " +
                "Start-Service FontCache -ErrorAction SilentlyContinue",
        ],
        admin: true,
        label: "Rebuild the Windows font cache",
    },
    // Only ever removes boot overrides and puts the documented default back, so
    // this is the safe direction through bcdedit rather than a tweak that uses it.
    resetBootTimers: {
        file: "powershell.exe",
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "bcdedit /deletevalue useplatformtick; bcdedit /deletevalue useplatformclock; bcdedit /set disabledynamictick no",
        ],
        admin: true,
        restart: true,
        label: "Put the boot timer settings back to Windows defaults",
    },
    openDisplaySettings: {
        file: "cmd.exe",
        args: ["/c", "start", "", "ms-settings:display-advanced"],
        admin: false,
        label: "Open the advanced display settings",
    },
    // Clear-RecycleBin is the supported way in: it goes through the shell, so
    // the bin icon updates and every drive is covered. Walking $Recycle.Bin and
    // deleting the files by hand would leave Windows still showing them.
    emptyRecycleBin: {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"],
        admin: false,
        label: "Empty the Recycle Bin on every drive",
        timeout: 300_000,
    },
    // "el" lists every log, "cl" clears one. Both come from wevtutil itself, so
    // no log name is composed here.
    clearEventLogs: {
        file: "powershell.exe",
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "wevtutil el | ForEach-Object { wevtutil cl \"$_\" 2>$null }",
        ],
        admin: true,
        label: "Clear all Windows event logs",
        timeout: 600_000,
    },
};

function validateCommand(op) {
    const id = String(op.command || "");
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, id)) throw new Error(`Unknown repair command: ${op.command}`);
    return { ...op, command: id };
}

// Running a tool is an action, not a state — there is nothing to read back and
// nothing to compare against.
const captureCommand = async (ops) => new Map(ops.map((op) => [op, { readFailed: false }]));
const commandIsApplied = () => null;

async function applyCommand(op) {
    const spec = COMMANDS[op.command];
    const res = await run(spec.file, spec.args, { timeout: spec.timeout || 300_000 });
    if (!res.ok) {
        return { ok: false, error: res.stderr || res.error || `${spec.file} exited with code ${res.code}` };
    }
    return { ok: true, detail: { output: res.stdout.slice(-400) || null, restartRequired: !!spec.restart } };
}

const restoreCommand = async (op) => ({
    ok: false,
    error: `"${COMMANDS[op.command].label}" is a repair action — there is no previous state to put back.`,
});

const describeCommand = (op) => {
    const spec = COMMANDS[op.command];
    return `${spec.label} (${spec.file} ${spec.args.join(" ")})`.trim();
};

const explainCommand = (op) => ({
    kind: "Repair",
    target: `${COMMANDS[op.command].file} ${COMMANDS[op.command].args.join(" ")}`.trim(),
    type: "",
    now: null,
    after: COMMANDS[op.command].label,
});

// ---------------------------------------------------------------------------
// Autostart entries
// ---------------------------------------------------------------------------

const STARTUP_SCOPES = new Set(["hkcuRun", "hklmRun", "hklmRun32", "hkcuFolder", "hklmFolder"]);
// Entry names come from Windows, not from the catalogue: they contain spaces,
// dots and umlauts. Control characters are the only thing worth refusing.
const STARTUP_NAME_RE = /^[^\x00-\x1f]{1,255}$/;

function validateStartup(op) {
    const name = String(op.name || "");
    const scope = String(op.scope || "");
    if (!STARTUP_NAME_RE.test(name)) throw new Error(`Invalid autostart entry name: ${op.name}`);
    if (!STARTUP_SCOPES.has(scope)) throw new Error(`Invalid autostart scope: ${op.scope}`);
    return { ...op, name, scope, enabled: op.enabled === true };
}

async function listStartupEntries() {
    const res = await runPsJson(path.join(PS_DIR, "startup.ps1"), { action: "list" }, {});
    const entries = res.data && Array.isArray(res.data.entries) ? res.data.entries : null;
    if (!res.ok || !entries) return { ok: false, error: res.error || "Could not read autostart entries", entries: [] };
    return {
        ok: true,
        error: null,
        entries: entries
            .filter((e) => e && STARTUP_NAME_RE.test(String(e.name || "")) && STARTUP_SCOPES.has(String(e.scope)))
            .map((e) => ({
                name: String(e.name),
                command: String(e.command || ""),
                scope: String(e.scope),
                source: String(e.source || ""),
                enabled: e.enabled !== false,
            })),
    };
}

async function captureStartup(ops) {
    if (!ops.length) return new Map();
    const res = await listStartupEntries();
    const out = new Map();
    for (const op of ops) {
        if (!res.ok) {
            out.set(op, { readFailed: true, error: res.error });
            continue;
        }
        const hit = res.entries.find((e) => e.name === op.name && e.scope === op.scope);
        // Gone from the Run key entirely: that is "not present", which is a
        // different answer from "could not read" and must not be confused with it.
        out.set(op, hit ? { exists: true, enabled: hit.enabled, command: hit.command } : { exists: false, enabled: null });
    }
    return out;
}

function startupIsApplied(op, cur) {
    if (!cur || cur.readFailed || !cur.exists) return null;
    return cur.enabled === op.enabled;
}

async function setStartup(name, scope, enabled) {
    const res = await runPsJson(path.join(PS_DIR, "startup.ps1"), { action: "set", entries: [{ name, scope, enabled }] }, {});
    const raw = res.data ? res.data[name] : null;
    if (!res.ok || !raw) return { ok: false, error: res.error || "The autostart entry produced no result" };
    return raw.ok ? { ok: true } : { ok: false, error: raw.error || "The autostart entry could not be changed" };
}

const applyStartup = (op) => setStartup(op.name, op.scope, op.enabled);

async function restoreStartup(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this autostart entry" };
    if (!prev.exists) return { ok: true }; // it was not there before; nothing to put back
    return setStartup(op.name, op.scope, prev.enabled);
}

const describeStartup = (op) =>
    `${op.enabled ? "Enable" : "Disable"} autostart entry "${op.name}" (${op.scope})`;

const explainStartup = (op, cur) => ({
    kind: "Autostart",
    target: op.name,
    type: op.scope,
    now: !cur || cur.readFailed ? null : !cur.exists ? "not present" : cur.enabled ? "enabled" : "disabled",
    after: op.enabled ? "enabled" : "disabled",
});

// ---------------------------------------------------------------------------
// Cleanup (one-time, deliberately not undoable)
// ---------------------------------------------------------------------------

const CLEANUP_ROOTS = {
    userTemp: () => process.env.TEMP || process.env.TMP,
    windowsTemp: () => path.join(process.env.SystemRoot || "C:\\Windows", "Temp"),
    prefetch: () => path.join(process.env.SystemRoot || "C:\\Windows", "Prefetch"),
    windowsUpdateCache: () =>
        path.join(process.env.SystemRoot || "C:\\Windows", "SoftwareDistribution", "Download"),
    crashDumps: () =>
        path.join(process.env.LOCALAPPDATA || "", "CrashDumps"),
    thumbnailCache: () =>
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Explorer"),
};

function validateCleanup(op) {
    const target = String(op.target || "");
    if (!CLEANUP_ROOTS[target]) throw new Error(`Unknown cleanup target: ${op.target}`);
    return { ...op, target, filePattern: op.filePattern ? String(op.filePattern) : null };
}

function walkFiles(dir, out, depth = 0, blocked = null) {
    if (depth > 12) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        // Unreadable: never counted as cleaned, and never counted as empty
        // either — those are different facts and the caller has to tell them
        // apart, or a folder needing admin reads as "0 B, nothing to do".
        if (blocked) blocked.push(dir);
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(full, out, depth + 1, blocked);
        else if (e.isFile()) {
            try {
                out.push({ full, size: fs.statSync(full).size });
            } catch {
                /* vanished between readdir and stat */
            }
        }
    }
}

function cleanupScan(op) {
    const root = CLEANUP_ROOTS[op.target]();
    if (!root || !fs.existsSync(root)) return { root, files: [], bytes: 0, blocked: [], readFailed: false };
    const files = [];
    const blocked = [];
    walkFiles(root, files, 0, blocked);
    const re = op.filePattern ? new RegExp(op.filePattern, "i") : null;
    const matched = re ? files.filter((f) => re.test(path.basename(f.full))) : files;
    return {
        root,
        files: matched,
        bytes: matched.reduce((a, f) => a + f.size, 0),
        blocked,
        // The root itself was unreadable: the count means nothing at all.
        readFailed: blocked.includes(root),
    };
}

// Cleanup has no "applied" state — it is a run-once action, so the UI renders a
// Run button instead of a toggle.
const captureCleanup = async (ops) => new Map(ops.map((op) => [op, cleanupScan(op)]));
const cleanupIsApplied = () => null;

async function applyCleanup(op) {
    const { root, files } = cleanupScan(op);
    if (!root) return { ok: false, error: `Cleanup target ${op.target} does not exist on this system` };
    let removed = 0;
    let freed = 0;
    let skipped = 0;
    for (const f of files) {
        try {
            fs.unlinkSync(f.full);
            removed++;
            freed += f.size;
        } catch {
            skipped++; // in use or protected — left alone on purpose
        }
    }
    return { ok: true, detail: { removed, skipped, freed } };
}

const restoreCleanup = async () => ({
    ok: false,
    error: "Deleting temporary files cannot be undone — this is a one-time action",
});

const describeCleanup = (op) => `Delete files in ${CLEANUP_ROOTS[op.target]() || op.target}`;

const explainCleanup = (op, cur) => ({
    kind: "Cleanup",
    target: CLEANUP_ROOTS[op.target]() || op.target,
    type: "",
    // The scan already counted what is there, so the dialog can say how much
    // this would actually free instead of a vague "cleans temporary files".
    // A folder that could not be opened reports nothing — not zero.
    now: !cur || cur.readFailed ? null : `${cur.files.length} files · ${formatBytes(cur.bytes)}`,
    // Partial reads are stated rather than folded into the total.
    note: cur && !cur.readFailed && cur.blocked?.length ? `${cur.blocked.length} subfolders unreadable` : null,
    after: "deleted",
});

function formatBytes(n) {
    if (typeof n !== "number") return "?";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Global TCP settings (netsh)
// ---------------------------------------------------------------------------

// Allowlisted like every other type: a tweak names "ecncapability", never a
// netsh command line. Each entry builds its own arguments because netsh is not
// consistent with itself - most settings are "set global name=value", window
// scaling heuristics takes no "global" and a space instead of "=", and Teredo
// lives under a different subcommand entirely.
//
// Writes go through netsh; reads do not. See read-nettcp.ps1 for why.
const NET_SETTINGS = {
    autotuninglevel: {
        label: "TCP receive window auto-tuning",
        values: ["disabled", "highlyrestricted", "restricted", "normal", "experimental"],
        args: (v) => ["int", "tcp", "set", "global", `autotuninglevel=${v}`],
    },
    ecncapability: {
        label: "ECN capability",
        values: ["enabled", "disabled"],
        args: (v) => ["int", "tcp", "set", "global", `ecncapability=${v}`],
    },
    timestamps: {
        label: "RFC 1323 timestamps",
        values: ["enabled", "disabled"],
        args: (v) => ["int", "tcp", "set", "global", `timestamps=${v}`],
    },
    heuristics: {
        label: "TCP window scaling heuristics",
        values: ["enabled", "disabled", "default"],
        args: (v) => ["int", "tcp", "set", "heuristics", v],
    },
    rss: {
        label: "Receive-side scaling",
        values: ["enabled", "disabled"],
        args: (v) => ["int", "tcp", "set", "global", `rss=${v}`],
    },
    rsc: {
        label: "Receive segment coalescing",
        values: ["enabled", "disabled"],
        args: (v) => ["int", "tcp", "set", "global", `rsc=${v}`],
    },
    teredo: {
        label: "Teredo IPv6 tunnelling",
        values: ["disabled", "default", "client", "server", "enterpriseclient"],
        args: (v) => ["interface", "teredo", "set", "state", v],
    },
};

function validateNetsh(op) {
    const setting = String(op.setting || "");
    const entry = NET_SETTINGS[setting];
    if (!entry) throw new Error(`Unknown network setting: ${op.setting}`);
    const value = String(op.value || "").toLowerCase();
    if (!entry.values.includes(value)) {
        throw new Error(`Invalid value for ${setting}: ${op.value} (expected ${entry.values.join(", ")})`);
    }
    return { setting, value };
}

// One script run covers every setting, however many operations ask for one.
async function captureNetsh(ops) {
    const out = new Map();
    if (!ops.length) return out;
    const res = await runPsJson(path.join(PS_DIR, "read-nettcp.ps1"), [], {});
    for (const op of ops) {
        if (!res.ok || !res.data) {
            out.set(op, { readFailed: true, error: res.error || "network settings could not be read" });
            continue;
        }
        const value = res.data[op.setting];
        // Absent means the script could not read that one, not that it is off.
        if (value === undefined || value === null) {
            out.set(op, { readFailed: true, error: `no reading for ${op.setting}` });
        } else {
            out.set(op, { value: String(value).toLowerCase() });
        }
    }
    return out;
}

function netshIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    return cur.value === op.value;
}

async function runNetsh(setting, value) {
    const res = await run("netsh.exe", NET_SETTINGS[setting].args(value));
    // netsh reports failure in its output as often as in its exit code, and
    // "Ok." is the one thing it prints on success in every language.
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout || `netsh exited ${res.code}` };
    return { ok: true };
}

const applyNetsh = (op) => runNetsh(op.setting, op.value);

async function restoreNetsh(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this network setting" };
    if (!NET_SETTINGS[op.setting].values.includes(prev.value)) {
        // Windows can report a state netsh will not accept back verbatim.
        return { ok: false, error: `Cannot restore "${prev.value}" - netsh does not accept it as a value` };
    }
    return runNetsh(op.setting, prev.value);
}

const describeNetsh = (op) => `Set ${NET_SETTINGS[op.setting].label} to ${op.value}`;

const explainNetsh = (op, cur) => ({
    kind: "Network",
    target: NET_SETTINGS[op.setting].label,
    type: "",
    now: cur && !cur.readFailed ? cur.value : null,
    after: op.value,
});

// ---------------------------------------------------------------------------
// Power scheme settings (powercfg)
// ---------------------------------------------------------------------------

// An allowlist, for the same reason the command type has one: a tweak asks for
// "coreParkingMin", never for an arbitrary GUID pair, so a bad definition fails
// validation instead of writing somewhere unexpected in the power scheme.
//
// Each entry names the subgroup and setting the way powercfg itself does -
// aliases where powercfg publishes one, raw GUIDs where it does not. Both forms
// are valid arguments to /setacvalueindex and /query, so nothing needs resolving
// first. The four aliased pairs were read back off a real machine rather than
// typed from memory; the two GUID pairs are the ones the original commands used.
const POWER_SETTINGS = {
    procMinState: { sub: "SUB_PROCESSOR", setting: "PROCTHROTTLEMIN", label: "Minimum processor state", unit: "%" },
    coreParkingMin: { sub: "SUB_PROCESSOR", setting: "CPMINCORES", label: "Core parking: minimum cores", unit: "%" },
    cpuIdleDisable: { sub: "SUB_PROCESSOR", setting: "IDLEDISABLE", label: "Processor idle states" },
    usbSelectiveSuspend: {
        sub: "2a737441-1930-4402-8d77-b2bebba308a3",
        setting: "48e6b7a6-50f5-4782-a5d4-53bb8f07e226",
        label: "USB selective suspend",
    },
    pcieAspm: {
        sub: "501a4d13-42af-4429-9fd1-a8218c268e20",
        setting: "ee12f906-d277-404b-b6da-e5fa1a576df5",
        label: "PCI Express link state power management",
    },
    displayTimeout: { sub: "SUB_VIDEO", setting: "VIDEOIDLE", label: "Turn off display after", unit: "s" },
};

const HIBERNATE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power";

function validatePowerCfg(op) {
    const action = String(op.action || "setting");
    if (action === "hibernate") {
        if (typeof op.enabled !== "boolean") throw new Error("powercfg hibernate needs enabled: true or false");
        return { action, enabled: op.enabled };
    }
    if (action !== "setting") throw new Error(`Unknown powercfg action: ${op.action}`);
    const setting = String(op.setting || "");
    if (!POWER_SETTINGS[setting]) throw new Error(`Unknown power setting: ${op.setting}`);
    // Coerce only from a number or a non-empty numeric string. Number(null) and
    // Number("") are both 0, so a definition that simply forgot its value would
    // otherwise validate as "set this to 0" - which for displayTimeout is the
    // real instruction "never turn the screen off".
    const raw = op.value;
    const value =
        typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`Invalid power setting value: ${op.value}`);
    }
    return { action, setting, value };
}

// powercfg prints the allowed range first and the two current indices last, AC
// before DC. Only the captions are translated, so the values are taken by
// position from the end - matching "Index der aktuellen Wechselstromeinstellung"
// would work on exactly one Windows language.
async function readPowerSetting(entry) {
    const res = await run("powercfg.exe", ["/query", "SCHEME_CURRENT", entry.sub, entry.setting]);
    if (!res.ok) {
        return { readFailed: true, error: res.stderr || res.stdout || `powercfg exited ${res.code}` };
    }
    const hex = String(res.stdout || "").match(/0x[0-9a-f]{8}/gi);
    if (!hex || hex.length < 2) {
        return { readFailed: true, error: "powercfg returned no current value for this setting" };
    }
    return { ac: parseInt(hex[hex.length - 2], 16), dc: parseInt(hex[hex.length - 1], 16) };
}

async function readHibernate() {
    const res = await run("reg.exe", ["query", HIBERNATE_KEY, "/v", "HibernateEnabled"]);
    if (!res.ok) {
        // Absent means hibernation was never enabled on this install, which is a
        // real answer rather than a failed read.
        if (/cannot find|nicht gefunden/i.test(res.stderr + res.stdout)) return { enabled: false };
        return { readFailed: true, error: res.stderr || res.stdout || `reg exited ${res.code}` };
    }
    const m = String(res.stdout || "").match(/REG_DWORD\s+0x([0-9a-f]+)/i);
    if (!m) return { readFailed: true, error: "Could not read HibernateEnabled" };
    return { enabled: parseInt(m[1], 16) !== 0 };
}

// One read per distinct setting, however many tweaks reference it.
async function capturePowerCfg(ops) {
    const out = new Map();
    const cache = new Map();
    for (const op of ops) {
        const key = op.action === "hibernate" ? "hibernate" : op.setting;
        if (!cache.has(key)) {
            cache.set(key, op.action === "hibernate" ? await readHibernate() : await readPowerSetting(POWER_SETTINGS[op.setting]));
        }
        out.set(op, cache.get(key));
    }
    return out;
}

function powerCfgIsApplied(op, cur) {
    if (!cur || cur.readFailed) return null;
    if (op.action === "hibernate") return cur.enabled === op.enabled;
    return cur.ac === op.value;
}

// Writing an index only edits the stored scheme; /setactive is what makes the
// running system pick it up. Skipping the second call is why the same tweak
// applied twice in a row still looked unapplied.
async function writePowerSetting(entry, value) {
    const set = await run("powercfg.exe", ["/setacvalueindex", "SCHEME_CURRENT", entry.sub, entry.setting, String(value)]);
    if (!set.ok) return { ok: false, error: set.stderr || set.stdout || `powercfg exited ${set.code}` };
    const activate = await run("powercfg.exe", ["/setactive", "SCHEME_CURRENT"]);
    if (!activate.ok) {
        return { ok: true, warning: "Value written, but the scheme could not be re-activated - it applies after the next sign-in" };
    }
    return { ok: true };
}

async function applyPowerCfg(op) {
    if (op.action === "hibernate") {
        const res = await run("powercfg.exe", ["/hibernate", op.enabled ? "on" : "off"]);
        return res.ok ? { ok: true } : { ok: false, error: res.stderr || res.stdout || `powercfg exited ${res.code}` };
    }
    return writePowerSetting(POWER_SETTINGS[op.setting], op.value);
}

async function restorePowerCfg(op, prev) {
    if (!prev || prev.readFailed) return { ok: false, error: "No captured state for this power setting" };
    if (op.action === "hibernate") {
        const res = await run("powercfg.exe", ["/hibernate", prev.enabled ? "on" : "off"]);
        return res.ok ? { ok: true } : { ok: false, error: res.stderr || res.stdout || `powercfg exited ${res.code}` };
    }
    return writePowerSetting(POWER_SETTINGS[op.setting], prev.ac);
}

function describePowerCfg(op) {
    if (op.action === "hibernate") return `Turn hibernation ${op.enabled ? "on" : "off"} (powercfg /hibernate)`;
    const e = POWER_SETTINGS[op.setting];
    return `Set "${e.label}" to ${op.value}${e.unit || ""} on mains power`;
}

function explainPowerCfg(op, cur) {
    if (op.action === "hibernate") {
        return {
            kind: "Power",
            target: "Hibernation",
            type: "",
            now: cur && !cur.readFailed ? (cur.enabled ? "On" : "Off") : null,
            after: op.enabled ? "On" : "Off",
        };
    }
    const e = POWER_SETTINGS[op.setting];
    return {
        kind: "Power setting",
        target: e.label,
        type: "on mains power",
        now: cur && !cur.readFailed ? `${cur.ac}${e.unit || ""}` : null,
        after: `${op.value}${e.unit || ""}`,
    };
}

// ---------------------------------------------------------------------------

const OPS = {
    registry: {
        validate: validateRegistry,
        capture: captureRegistry,
        isApplied: registryIsApplied,
        apply: applyRegistry,
        restore: restoreRegistry,
        describe: describeRegistry,
        explain: explainRegistry,
        requiresAdmin: (op) => HIVES[op.hive].admin,
        undoable: true,
    },
    registryScan: {
        validate: validateRegistryScan,
        capture: captureRegistryScan,
        isApplied: registryScanIsApplied,
        apply: applyRegistryScan,
        restore: restoreRegistryScan,
        describe: describeRegistryScan,
        explain: explainRegistryScan,
        requiresAdmin: () => true, // every scope lives under HKLM
        undoable: true,
    },
    gameConfig: {
        validate: validateGameConfig,
        capture: captureGameConfig,
        isApplied: gameConfigIsApplied,
        apply: applyGameConfig,
        restore: restoreGameConfig,
        describe: describeGameConfig,
        explain: explainGameConfig,
        requiresAdmin: () => false, // the file lives in the user's own profile
        undoable: true,
    },
    perApp: {
        validate: validatePerApp,
        capture: capturePerApp,
        isApplied: perAppIsApplied,
        apply: applyPerApp,
        restore: restorePerApp,
        describe: describePerApp,
        explain: explainPerApp,
        // Only the IFEO priority key lives under HKLM.
        requiresAdmin: (op) => APP_SETTINGS[op.setting].hive === "HKLM",
        undoable: true,
    },
    toggle: {
        validate: validateToggle,
        capture: captureToggles,
        isApplied: toggleIsApplied,
        apply: applyToggle,
        restore: restoreToggle,
        describe: describeToggle,
        explain: explainToggle,
        requiresAdmin: () => true, // both of these need it even to read
        undoable: true,
    },
    service: {
        validate: validateService,
        capture: captureServices,
        isApplied: serviceIsApplied,
        apply: applyService,
        restore: restoreService,
        describe: describeService,
        explain: explainService,
        requiresAdmin: () => true,
        undoable: true,
    },
    scheduledTask: {
        validate: validateTask,
        capture: captureTasks,
        isApplied: taskIsApplied,
        apply: applyTask,
        restore: restoreTask,
        describe: describeTask,
        explain: explainTask,
        requiresAdmin: () => true,
        undoable: true,
    },
    appx: {
        validate: validateAppx,
        capture: captureAppx,
        isApplied: appxIsApplied,
        apply: applyAppx,
        restore: restoreAppx,
        describe: describeAppx,
        explain: explainAppx,
        requiresAdmin: () => false, // per-user removal
        undoable: false,
    },
    netsh: {
        validate: validateNetsh,
        capture: captureNetsh,
        isApplied: netshIsApplied,
        apply: applyNetsh,
        restore: restoreNetsh,
        describe: describeNetsh,
        explain: explainNetsh,
        requiresAdmin: () => true,
        undoable: true,
    },
    powercfg: {
        validate: validatePowerCfg,
        capture: capturePowerCfg,
        isApplied: powerCfgIsApplied,
        apply: applyPowerCfg,
        restore: restorePowerCfg,
        describe: describePowerCfg,
        explain: explainPowerCfg,
        requiresAdmin: () => true,
        undoable: true,
    },
    // Placeholder for commands the converter could not translate into a typed,
    // reversible operation (powercfg, netsh, bcdedit, ...). Validation fails on
    // purpose, which marks the whole tweak unavailable with a readable reason
    // instead of shipping something that cannot be undone.
    unsupported: {
        validate: (op) => {
            throw new Error(op.reason || "This operation is not implemented yet");
        },
        capture: async (ops) => new Map(ops.map((op) => [op, { readFailed: true }])),
        isApplied: () => null,
        apply: async () => ({ ok: false, error: "Not implemented yet" }),
        restore: async () => ({ ok: false, error: "Not implemented yet" }),
        describe: (op) => `Not implemented yet: ${op.command || "unknown command"}`,
        explain: (op) => ({ kind: "Not implemented", target: op.command || "", type: "", now: null, after: "—" }),
        requiresAdmin: () => true,
        undoable: false,
    },
    command: {
        validate: validateCommand,
        capture: captureCommand,
        isApplied: commandIsApplied,
        apply: applyCommand,
        restore: restoreCommand,
        describe: describeCommand,
        explain: explainCommand,
        requiresAdmin: (op) => COMMANDS[op.command].admin,
        undoable: false,
        // Nothing to read: a blanket scan would spawn processes for no answer.
        detectable: false,
    },
    startup: {
        validate: validateStartup,
        capture: captureStartup,
        isApplied: startupIsApplied,
        apply: applyStartup,
        restore: restoreStartup,
        describe: describeStartup,
        explain: explainStartup,
        // Only the machine-wide keys need elevation; a user's own Run entries
        // are writable as a standard user.
        requiresAdmin: (op) => op.scope.startsWith("hklm"),
        undoable: true,
    },
    cleanup: {
        validate: validateCleanup,
        capture: captureCleanup,
        isApplied: cleanupIsApplied,
        apply: applyCleanup,
        restore: restoreCleanup,
        describe: describeCleanup,
        explain: explainCleanup,
        requiresAdmin: (op) => op.target !== "userTemp",
        undoable: false,
        // "Are these files deleted?" has no meaningful answer, and finding out
        // costs a full directory walk. Blanket scans skip this type; the cleanup
        // page asks for it by id and gets real sizes.
        detectable: false,
    },
};

function getOp(type) {
    const handler = OPS[type];
    if (!handler) throw new Error(`Unknown operation type: ${type}`);
    return handler;
}

function validateOp(op) {
    const handler = getOp(op && op.type);
    return { ...handler.validate(op), type: op.type };
}

module.exports = {
    OPS,
    getOp,
    validateOp,
    normalizeRegValue,
    POWER_SETTINGS,
    NET_SETTINGS,
    SCAN_SCOPES,
    SCAN_SETTINGS,
    scanKeyAllowed,
    TOGGLES,
    COMMANDS,
    APPS,
    APP_SETTINGS,
    findExe,
    GAME_CONFIGS,
    GAME_SETTINGS,
    iniRead,
    iniWrite,
    perAppWithToken,
    perAppHasToken,
    CLEANUP_ROOTS,
    cleanupScan,
    listInstalledApps,
    regWriteError,
    listStartupEntries,
    isProtectedPackage,
};
