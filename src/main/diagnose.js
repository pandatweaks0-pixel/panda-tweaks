"use strict";

// Crash diagnosis. Read-only: it reads what Windows already recorded and says
// which part of the machine that points at. It never changes anything, so it
// has no history entry and nothing to undo.
//
// What it does not do is name the faulting driver. That needs a debugger
// walking the stack inside the minidump; guessing it from the module list is
// how "optimizers" end up blaming whatever driver happens to be loaded. The
// stop code and the surrounding events are what can be said honestly.

const path = require("path");
const { runPsJson } = require("./shell");

// Stop code -> official name and the area it points at. Only codes common
// enough on gaming PCs to be worth an explanation; anything else is shown with
// its number and "other".
const STOP_CODES = {
    0x0a: ["IRQL_NOT_LESS_OR_EQUAL", "driver"],
    0x1e: ["KMODE_EXCEPTION_NOT_HANDLED", "driver"],
    0x3b: ["SYSTEM_SERVICE_EXCEPTION", "driver"],
    0x7e: ["SYSTEM_THREAD_EXCEPTION_NOT_HANDLED", "driver"],
    0x9f: ["DRIVER_POWER_STATE_FAILURE", "driver"],
    0xd1: ["DRIVER_IRQL_NOT_LESS_OR_EQUAL", "driver"],
    0x133: ["DPC_WATCHDOG_VIOLATION", "driver"],
    0x139: ["KERNEL_SECURITY_CHECK_FAILURE", "driver"],
    0x19: ["BAD_POOL_HEADER", "ram"],
    0x1a: ["MEMORY_MANAGEMENT", "ram"],
    0x4e: ["PFN_LIST_CORRUPT", "ram"],
    0x50: ["PAGE_FAULT_IN_NONPAGED_AREA", "ram"],
    0x101: ["CLOCK_WATCHDOG_TIMEOUT", "hardware"],
    0x124: ["WHEA_UNCORRECTABLE_ERROR", "hardware"],
    0x10e: ["VIDEO_MEMORY_MANAGEMENT_INTERNAL", "gpu"],
    0x116: ["VIDEO_TDR_FAILURE", "gpu"],
    0x117: ["VIDEO_TDR_TIMEOUT_DETECTED", "gpu"],
    0x119: ["VIDEO_SCHEDULER_INTERNAL_ERROR", "gpu"],
    0x141: ["VIDEO_ENGINE_TIMEOUT_DETECTED", "gpu"],
    0x7a: ["KERNEL_DATA_INPAGE_ERROR", "storage"],
    0xef: ["CRITICAL_PROCESS_DIED", "storage"],
};

// WHEA ids Windows logs for errors it could not correct.
const WHEA_FATAL = new Set([1, 18]);

const hex = (n) => `0x${n.toString(16).toUpperCase()}`;

// "0x0000003b (0x..., ...)" -> 0x3b
function stopCode(raw) {
    const m = /^\s*0x([0-9a-f]+)/i.exec(String(raw || ""));
    return m ? Number.parseInt(m[1], 16) : null;
}

const latest = (list) => list.map((x) => x.at).sort().at(-1) || null;

// Kernel-Power 41 is written at the next boot, a few seconds before the
// bugcheck event of the same crash. Counting both would report every blue
// screen twice, once as a crash and once as a freeze.
const SAME_CRASH_MS = 60_000;

function summarize(raw) {
    const r = raw || {};
    const findings = [];

    const byCode = new Map();
    for (const b of r.bugchecks || []) {
        const code = stopCode(b.code);
        if (code === null) continue;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(b);
    }
    for (const [code, list] of byCode) {
        const [name, area] = STOP_CODES[code] || [null, "other"];
        findings.push({ kind: "bugcheck", code: hex(code), name, area, count: list.length, last: latest(list) });
    }

    // Only the shutdowns no blue screen explains: no bugcheck code, and no
    // bugcheck event recorded for the same moment.
    const crashTimes = (r.bugchecks || []).map((b) => Date.parse(b.at));
    const freezes = (r.powerLoss || []).filter(
        (p) => !p.bugcheck && !crashTimes.some((t) => Math.abs(t - Date.parse(p.at)) < SAME_CRASH_MS)
    );
    if (freezes.length) findings.push({ kind: "freeze", area: "power", count: freezes.length, last: latest(freezes) });

    const resets = r.displayResets || [];
    if (resets.length) {
        const drivers = [...new Set(resets.map((d) => d.driver).filter(Boolean))].join(", ");
        findings.push({ kind: "displayReset", area: "gpu", driver: drivers || null, count: resets.length, last: latest(resets) });
    }

    // WATCHDOG is where Windows files a graphics hang it recovered from.
    const hangs = r.liveReports || [];
    const gpuHangs = hangs.filter((h) => /watchdog/i.test(h.kind));
    const otherHangs = hangs.filter((h) => !gpuHangs.includes(h));
    if (gpuHangs.length) findings.push({ kind: "gpuHang", area: "gpu", count: gpuHangs.length, last: latest(gpuHangs) });
    if (otherHangs.length) {
        const kinds = [...new Set(otherHangs.map((h) => h.kind))].join(", ");
        findings.push({ kind: "hang", area: "other", driver: kinds, count: otherHangs.length, last: latest(otherHangs) });
    }

    const whea = r.hardwareErrors || [];
    const fatal = whea.filter((w) => WHEA_FATAL.has(w.id));
    const corrected = whea.filter((w) => !WHEA_FATAL.has(w.id));
    if (fatal.length) findings.push({ kind: "wheaFatal", area: "hardware", count: fatal.length, last: latest(fatal) });
    if (corrected.length) findings.push({ kind: "wheaCorrected", area: "hardware", count: corrected.length, last: latest(corrected) });

    findings.sort((a, b) => String(b.last).localeCompare(String(a.last)));
    return findings;
}

async function diagnoseCrashes() {
    const res = await runPsJson(path.join(__dirname, "ps", "crashes.ps1"), undefined, null);
    if (!res.ok || !res.data) return { ok: false, error: res.error || "Could not read the event log", findings: [] };
    return { ok: true, error: null, findings: summarize(res.data) };
}

module.exports = { diagnoseCrashes, summarize, stopCode, STOP_CODES };
