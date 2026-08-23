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

    const payload = {
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        analysis,
        scores,
        detection,
        recommendations: recommend(analysis, scores, detection),
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

function recommend(analysis, scores, detection) {
    const statusById = new Map(detection.map((d) => [d.id, d]));
    const context = contextReasons(analysis, scores);
    const out = [];

    for (const tweak of engine.getTweaks()) {
        if (tweak.unavailable) continue;
        const state = statusById.get(tweak.id);
        if (!state || !state.supported) continue;
        // Already in place, or we could not read it — either way, do not push it.
        if (state.status !== "not-applied" && state.status !== "partial") continue;
        // Risky tweaks are never recommended automatically.
        if (tweak.risk === "risky") continue;

        if (tweak.recommended) {
            out.push({ id: tweak.id, category: tweak.category, risk: tweak.risk, reason: "reason.generallyRecommended" });
        } else if (context.has(tweak.category) && tweak.risk === "advanced") {
            out.push({ id: tweak.id, category: tweak.category, risk: tweak.risk, reason: context.get(tweak.category) });
        }
    }
    return out;
}

module.exports = { init, analyze, getCached, recommend, contextReasons };
