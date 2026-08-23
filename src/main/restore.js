"use strict";

// System Restore Point handling.
//
// The one rule here: never report success unless a new restore point was
// observed to exist afterwards. Every failure path returns a `reason` the UI can
// turn into a specific, honest message.

const path = require("path");
const { runPsJson } = require("./shell");
const logger = require("./logger");

const SCRIPT = path.join(__dirname, "ps", "restore-point.ps1");

const REASONS = new Set([
    "created",
    "throttled",
    "protection-disabled",
    "needs-admin",
    "error",
    "available",
    "protection-unknown",
]);

async function call(action, description) {
    const res = await runPsJson(SCRIPT, { action, description }, null);
    if (!res.ok || !res.data) {
        return {
            ok: false,
            created: false,
            reason: "error",
            message: res.error || "The restore point helper produced no output.",
        };
    }
    const d = res.data;
    return {
        ok: !!d.ok,
        created: !!d.created,
        reason: REASONS.has(d.reason) ? d.reason : "error",
        message: String(d.message || ""),
        sequence: d.sequence ?? null,
        pointCount: d.pointCount ?? null,
        points: Array.isArray(d.points) ? d.points : [],
    };
}

const status = () => call("status", "Panda Tweaks");

async function create(description = "Panda Tweaks") {
    const result = await call("create", description);
    logger.info(result.created ? "Restore point created" : "Restore point NOT created", {
        reason: result.reason,
        sequence: result.sequence,
    });
    return result;
}

module.exports = { status, create };
