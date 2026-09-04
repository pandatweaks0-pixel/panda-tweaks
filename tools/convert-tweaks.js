"use strict";

// One-off converter: turns the the source export command strings into Panda Tweaks
// typed operations.
//
// Anything this cannot translate with confidence is written out as an
// "unsupported" operation carrying the original command text. Those tweaks ship
// disabled and labelled, rather than silently dropped or half-converted —
// guessing at what a command does is how you get an undo that corrupts state.
//
// Usage: node tools/convert-source-export.js <path-to-the source export/app> [--write]

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = process.argv[2] || "C:\\Users\\henri\\Downloads\\the source export-Source\\app";
const WRITE = process.argv.includes("--write");
const OUT_DIR = path.join(__dirname, "..", "src", "data");

// the source export categories -> Panda Tweaks categories.
const CATEGORY_MAP = {
    Windows: "Windows",
    Security: "Privacy",
    CPU: "Performance",
    Memory: "Performance",
    GPU: "Performance",
    Input: "Gaming",
    Network: "Network",
    Clean: "Debloat",
    Audio: "Windows",
};

const HIVE_MAP = {
    HKCU: "HKCU",
    HKEY_CURRENT_USER: "HKCU",
    HKLM: "HKLM",
    HKEY_LOCAL_MACHINE: "HKLM",
    HKCR: "HKCR",
    HKEY_CLASSES_ROOT: "HKCR",
    HKU: "HKU",
    HKEY_USERS: "HKU",
};

// --- loading -----------------------------------------------------------------

function loadWindowGlobal(file, prop) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const sandbox = { window: {} };
    vm.runInNewContext(src, sandbox, { timeout: 10_000 });
    const value = sandbox.window[prop];
    if (!value) throw new Error(`${file} did not define window.${prop}`);
    return value;
}

// --- command parsing ---------------------------------------------------------

// Splits "a & b && c" into individual commands without breaking quoted text.
function splitCommands(cmd) {
    const parts = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            cur += c;
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            cur += c;
            continue;
        }
        if (c === "&") {
            if (cmd[i + 1] === "&") i++;
            parts.push(cur.trim());
            cur = "";
            continue;
        }
        cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.filter(Boolean);
}

function tokenize(cmd) {
    const tokens = [];
    let cur = "";
    let quote = null;
    let hadQuote = false;
    for (const c of cmd) {
        if (quote) {
            if (c === quote) quote = null;
            else cur += c;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            hadQuote = true;
            continue;
        }
        if (/\s/.test(c)) {
            if (cur || hadQuote) tokens.push(cur);
            cur = "";
            hadQuote = false;
            continue;
        }
        cur += c;
    }
    if (cur || hadQuote) tokens.push(cur);
    return tokens;
}

function splitRegPath(full) {
    const idx = full.indexOf("\\");
    if (idx < 0) return null;
    const hive = HIVE_MAP[full.slice(0, idx).toUpperCase()];
    const key = full.slice(idx + 1);
    if (!hive || !key) return null;
    return { hive, key };
}

// Returns an operation, or { type: "unsupported" } when the command is anything
// this converter is not sure about.
function parseCommand(raw) {
    const tokens = tokenize(raw);
    if (!tokens.length) return null;
    const verb = tokens[0].toLowerCase().replace(/\.exe$/, "");

    if (verb === "reg") {
        const sub = (tokens[1] || "").toLowerCase();
        const parsed = splitRegPath(tokens[2] || "");
        if (!parsed) return { type: "unsupported", command: raw, reason: "unrecognised registry path" };

        const flags = {};
        for (let i = 3; i < tokens.length; i++) {
            const t = tokens[i].toLowerCase();
            if (t === "/v") flags.v = tokens[++i];
            else if (t === "/t") flags.t = tokens[++i];
            else if (t === "/d") flags.d = tokens[++i];
            else if (t === "/ve") flags.v = "";
        }

        if (sub === "add") {
            if (flags.v === undefined)
                return { type: "unsupported", command: raw, reason: "reg add without a value name" };
            return {
                type: "registry",
                action: "set",
                hive: parsed.hive,
                key: parsed.key,
                name: flags.v,
                valueType: (flags.t || "REG_SZ").toUpperCase(),
                value: flags.d !== undefined ? flags.d : "",
            };
        }
        if (sub === "delete") {
            if (flags.v === undefined) {
                // Deleting a whole key is not expressible as a reversible
                // operation here — it would need a full subtree snapshot.
                return { type: "unsupported", command: raw, reason: "deletes an entire registry key" };
            }
            return {
                type: "registry",
                action: "delete",
                hive: parsed.hive,
                key: parsed.key,
                name: flags.v,
            };
        }
        return { type: "unsupported", command: raw, reason: `unhandled reg verb "${sub}"` };
    }

    if (verb === "sc") {
        const sub = (tokens[1] || "").toLowerCase();
        if (sub === "config") {
            const name = tokens[2];
            const startIdx = tokens.findIndex((t) => t.toLowerCase() === "start=");
            const value = startIdx >= 0 ? (tokens[startIdx + 1] || "").toLowerCase() : null;
            const map = { disabled: "disabled", demand: "manual", auto: "auto", "delayed-auto": "delayed-auto" };
            if (name && map[value]) return { type: "service", name, startMode: map[value] };
            return { type: "unsupported", command: raw, reason: "sc config without a known start type" };
        }
        // sc stop/start on their own are folded into the service operation.
        if (sub === "stop" || sub === "start") return null;
        return { type: "unsupported", command: raw, reason: `unhandled sc verb "${sub}"` };
    }

    if (verb === "schtasks") {
        const lower = tokens.map((t) => t.toLowerCase());
        const tnIdx = lower.indexOf("/tn");
        const taskPath = tnIdx >= 0 ? tokens[tnIdx + 1] : null;
        if (!taskPath) return { type: "unsupported", command: raw, reason: "schtasks without /tn" };
        if (lower.includes("/disable")) return { type: "scheduledTask", path: taskPath, enabled: false };
        if (lower.includes("/enable")) return { type: "scheduledTask", path: taskPath, enabled: true };
        return { type: "unsupported", command: raw, reason: "schtasks without /enable or /disable" };
    }

    // powercfg, netsh, bcdedit, powershell, cmd, wsreset, ipconfig: each needs
    // its own capture/restore implementation before it can ship.
    return { type: "unsupported", command: raw, reason: `"${verb}" operations are not implemented yet` };
}

function parseAll(commandString) {
    if (!commandString) return [];
    return splitCommands(commandString).map(parseCommand).filter(Boolean);
}

// The original revert command tells us what the source export considered the Windows
// default. Kept as a display-only hint; undo uses the captured snapshot.
function defaultsFromRevert(revert) {
    const out = {};
    for (const op of parseAll(revert)) {
        if (op.type === "registry") {
            const label = `${op.hive}\\${op.key}\\${op.name}`;
            out[label] = op.action === "delete" ? "(value removed)" : op.value;
        }
    }
    return Object.keys(out).length ? out : null;
}

// Cleanup tweaks are shell one-liners in the source. These map onto the typed
// cleanup operation, which walks the folder in Node and reports how much it
// actually removed. Only entries whose target is covered by CLEANUP_ROOTS are
// listed — the rest (recycle bin, DNS cache, DISM, event logs) stay unsupported
// until they have a real implementation.
const CLEANUP_MAP = {
    clean_temp: [{ type: "cleanup", target: "userTemp" }, { type: "cleanup", target: "windowsTemp" }],
    clean_prefetch: [{ type: "cleanup", target: "prefetch" }],
    clean_update_cache: [{ type: "cleanup", target: "windowsUpdateCache" }],
    clean_crash_dumps: [{ type: "cleanup", target: "crashDumps" }],
    clean_thumbnails: [
        { type: "cleanup", target: "thumbnailCache", filePattern: "^thumbcache_.*\\.db$" },
    ],
};

// --- conversion --------------------------------------------------------------

function convertTweaks() {
    // The global name below is the identifier inside the input file, not a
    // label of our own - the importer has to look for exactly what is there.
    const source = loadWindowGlobal("tweaks.js", "slideTweaks");
    const report = { total: source.length, converted: 0, unsupported: 0, reasons: {} };
    const out = [];

    for (const t of source) {
        const ops = CLEANUP_MAP[t.id] || parseAll(t.command);
        const unsupported = ops.filter((o) => o.type === "unsupported");
        const isCleanupOnly = !t.revert || t.revert.trim() === "";

        for (const u of unsupported) {
            report.reasons[u.reason] = (report.reasons[u.reason] || 0) + 1;
        }
        if (unsupported.length) report.unsupported++;
        else report.converted++;

        out.push({
            id: t.id,
            name: t.name,
            category: CATEGORY_MAP[t.category] || "Windows",
            sourceCategory: t.category,
            risk: t.risk,
            description: t.description,
            detailedDescription: t.description,
            // Safe tweaks are pre-selected; advanced is opt-in; risky never.
            recommended: t.risk === "safe" && !unsupported.length,
            requiresRestart: /reboot|restart|neustart/i.test(t.description || ""),
            oneTimeAction: isCleanupOnly,
            windowsDefault: defaultsFromRevert(t.revert),
            warnings: t.risk === "risky" ? ["Weakens a Windows security feature"] : [],
            operations: ops,
            // Preserved verbatim so a reviewer can diff a converted tweak against
            // what the original actually ran.
            originalCommand: t.command,
            originalRevert: t.revert || null,
        });
    }
    return { tweaks: out, report };
}

function convertServices() {
    const source = loadWindowGlobal("services.js", "slideServices");
    return source.map((s) => ({
        name: s.name,
        label: s.label,
        description: s.desc,
        // "safe" in the source means "almost everyone can disable this".
        recommended: s.safe === true,
        risk: s.safe === true ? "safe" : "advanced",
    }));
}

function convertDebloat() {
    const source = loadWindowGlobal("debloat.js", "slideDebloat");
    const list = Array.isArray(source) ? source : source.apps || [];
    return list
        // `pkg` is the package-name fragment ("BingNews"); the id is not a
        // package name and must never be used as one.
        .filter((a) => a.pkg)
        .map((a) => ({
            id: a.id,
            package: String(a.pkg),
            name: a.name || a.id,
            description: a.desc || a.description || "",
            recommended: a.safe === true,
            risk: a.safe === true ? "safe" : "advanced",
        }));
}

// --- main --------------------------------------------------------------------

function main() {
    const { tweaks, report } = convertTweaks();

    console.log("=== tweaks ===");
    console.log(`total:            ${report.total}`);
    console.log(`fully converted:  ${report.converted}`);
    console.log(`has unsupported:  ${report.unsupported}`);
    console.log("\nreasons:");
    for (const [reason, count] of Object.entries(report.reasons).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  ${reason}`);
    }

    const byCategory = {};
    for (const t of tweaks) byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    console.log("\ncategories:", JSON.stringify(byCategory));

    let services = [];
    let debloat = [];
    try {
        services = convertServices();
    } catch (e) {
        console.log("services.js:", e.message);
    }
    try {
        debloat = convertDebloat();
    } catch (e) {
        console.log("debloat.js:", e.message);
    }
    console.log(`services: ${services.length}, debloat apps: ${debloat.length}`);

    if (!WRITE) {
        console.log("\n(dry run — pass --write to emit src/data/*.json)");
        return;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "tweaks.json"), JSON.stringify(tweaks, null, 2), "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "services.json"), JSON.stringify(services, null, 2), "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "debloat.json"), JSON.stringify(debloat, null, 2), "utf8");
    console.log(`\nwrote ${OUT_DIR}`);
}

main();
