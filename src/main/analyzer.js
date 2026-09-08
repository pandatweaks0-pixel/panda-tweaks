"use strict";

// System analysis and tweak recommendations.
//
// The analysis itself is read-only (see ps/analyze.ps1). Results are cached to
// disk so the app opens on the last known state instead of blocking on a fresh
// scan every launch — the user re-scans explicitly.

const fs = require("fs");
const path = require("path");
const { runPsJson } = require("./shell");
const { computeScores } = require("./scores");
const engine = require("./engine");
const logger = require("./logger");

const PS_DIR = path.join(__dirname, "ps");
let cachePath = null;
let cached = null;

function init(userDataDir) {
    cachePath = path.join(userDataDir, "analysis.json");
    try {
        cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
        cached = null; // first run
    }
}

function saveCache(payload) {
    cached = payload;
    if (!cachePath) return;
    try {
        fs.writeFileSync(cachePath, JSON.stringify(payload), "utf8");
    } catch (e) {
        logger.warn("Could not cache analysis", { error: e.message });
    }
}

const getCached = () => cached;

async function analyze() {
    const started = Date.now();
    const res = await runPsJson(path.join(PS_DIR, "analyze.ps1"), undefined, null);
    if (!res.ok || !res.data) {
        logger.error("System analysis failed", { error: res.error });
        return { ok: false, error: res.error || "System analysis produced no output" };
    }

    const analysis = res.data;
    const scores = computeScores(analysis);
    const build = analysis.windows?.build ?? null;

    let detection = [];
    try {
        detection = await engine.detect(null, build);
    } catch (e) {
        logger.error("Tweak detection failed during analysis", { error: e.message });
    }

    const { list, skipped, unfit } = recommend(analysis, scores, detection);
    const payload = {
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        analysis,
        scores,
        detection,
        recommendations: list,
        skipped,
        unfit,
    };
    saveCache(payload);
    logger.info("System analysis complete", {
        durationMs: payload.durationMs,
        overall: scores.overall,
        recommended: payload.recommendations.length,
    });
    return { ok: true, ...payload };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

// Context rules add a reason to whole categories when the analysis shows the
// machine would actually benefit. A tweak is only ever recommended when it is
// available, supported, and not already in place.
function contextReasons(analysis, scores) {
    const reasons = new Map(); // category -> reason key

    const gpu = analysis.gpus?.[0];
    const hasDiscreteGpu = /nvidia|radeon|geforce|rtx|gtx|arc/i.test(gpu?.name || "");
    const highRefresh = (gpu?.maxRefresh || 0) > 75;
    if (hasDiscreteGpu || highRefresh) {
        reasons.set("Gaming", "reason.gamingHardware");
    }
    if ((scores.privacy?.score ?? 100) < 75) {
        reasons.set("Privacy", "reason.privacyLow");
    }
    if ((analysis.installedApps?.length ?? 0) > 40 || (analysis.startup?.length ?? 0) > 8) {
        reasons.set("Debloat", "reason.manyPreinstalled");
    }
    if ((scores.performance?.score ?? 100) < 75) {
        reasons.set("Performance", "reason.performanceLow");
    }
    return reasons;
}

// A tweak that keeps hardware awake costs a desktop nothing and costs a laptop
// its battery. Rather than maintaining a list by hand, this asks the operations:
// everything that edits the power scheme qualifies, so a powercfg tweak added
// later is covered without anyone remembering to add it here. Only the one
// exception that is not a powercfg operation has to be named.
const ALSO_DRAINS_BATTERY = new Set(["cpu_powerthrottle_off"]);

// Device power saving is the whole point of these settings, so switching it off
// costs battery for the same reason it helps latency. The other registryScan
// settings (interrupts, audio effects, TCP) cost nothing on a laptop.
const BATTERY_SETTINGS = new Set([
    "usbInputEpm",
    "usbInputSuspend",
    "usbControllerEpm",
    "usbControllerSuspend",
    "btEpm",
]);

const drainsBattery = (tweak) =>
    ALSO_DRAINS_BATTERY.has(tweak.id) ||
    (tweak.operations || []).some(
        (op) => op.type === "powercfg" || (op.type === "registryScan" && BATTERY_SETTINGS.has(op.setting))
    );

// Tweaks whose own description names a hardware condition. Keeping the rule here
// rather than in tweaks.json means the converter cannot overwrite it, and it
// stays next to the code that enforces it.
const NEEDS_SSD = new Set(["mem_prefetch_off"]); // "SSD only. Do NOT use on HDDs."
const NEEDS_RAM_GB = { cpu_pagingexec: 16 }; // "needs plenty of RAM"

// Does this tweak suit this machine? Returns null when it fits, or the reason it
// does not, ready to show.
//
// Anything unproven counts as not fitting. That is the opposite of how detection
// treats an unreadable value - there, "I could not look" must never become a
// verdict - but the question is different. Detection reports what IS; this
// decides what to DO unasked, and the honest default for "I cannot tell whether
// this would help or hurt" is to leave it for the user to choose deliberately.
// Every one of these stays applicable by hand from the tweak list.
function machineFit(tweak, analysis) {
    if (analysis.isLaptop === true && drainsBattery(tweak)) return "skipped.laptopBattery";

    if (NEEDS_SSD.has(tweak.id) && String(analysis.systemDriveType || "").toUpperCase() !== "SSD") {
        return analysis.systemDriveType ? "skipped.needsSsd" : "skipped.driveUnknown";
    }

    const needRam = NEEDS_RAM_GB[tweak.id];
    if (needRam !== undefined) {
        const have = analysis.ram && analysis.ram.totalGB;
        if (!have) return "skipped.ramUnknown";
        if (have < needRam) return "skipped.needsRam";
    }

    return null;
}

// Returns both halves of the decision. The list is what gets offered; skipped is
// what was deliberately held back and why — the two policy exclusions only, not
// every tweak that happens to be applied already. "Nothing to do here" is not a
// decision worth explaining; "your laptop, so no" is.
function recommend(analysis, scores, detection) {
    const statusById = new Map(detection.map((d) => [d.id, d]));
    const context = contextReasons(analysis, scores);
    const list = [];
    const skipped = [];
    // Every usable tweak that does not suit this machine, whether or not it
    // would have been recommended. The renderer needs the full set, because a
    // preset is a fixed list of ids that never passed through the loop below.
    const unfit = [];

    for (const tweak of engine.getTweaks()) {
        if (tweak.unavailable) continue;

        // Judged against the hardware, not against what the user selected, so
        // this verdict is equally valid for a preset the user presses later.
        const misfit = machineFit(tweak, analysis);
        if (misfit) unfit.push({ id: tweak.id, name: tweak.name, reason: misfit });

        const state = statusById.get(tweak.id);
        if (!state || !state.supported) continue;
        // Already in place, or we could not read it — either way, do not push it.
        if (state.status !== "not-applied" && state.status !== "partial") continue;

        const wouldOffer = tweak.recommended || (context.has(tweak.category) && tweak.risk === "advanced");

        // Risky tweaks are never recommended automatically.
        if (tweak.risk === "risky") {
            if (wouldOffer) skipped.push({ id: tweak.id, name: tweak.name, reason: "skipped.risky" });
            continue;
        }
        if (misfit) {
            if (wouldOffer) skipped.push({ id: tweak.id, name: tweak.name, reason: misfit });
            continue;
        }

        if (tweak.recommended) {
            list.push({ id: tweak.id, category: tweak.category, risk: tweak.risk, reason: "reason.generallyRecommended" });
        } else if (context.has(tweak.category) && tweak.risk === "advanced") {
            list.push({ id: tweak.id, category: tweak.category, risk: tweak.risk, reason: context.get(tweak.category) });
        }
    }
    return { list, skipped, unfit };
}

module.exports = { init, analyze, getCached, recommend, contextReasons, machineFit };
