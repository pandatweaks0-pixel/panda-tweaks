"use strict";

// User settings, stored as plain JSON next to the log and history files.
// Nothing here is sent anywhere; there is no account and no telemetry.

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const DEFAULTS = {
    firstRunComplete: false,
    language: null, // null = ask on first run
    theme: "dark",
    accentColor: "#4ade80",
    askForRestorePoint: true,
    showRiskyTweaks: false,
    confirmBeforeApply: true,
    lastScanAt: null,
};

let filePath = null;
let current = { ...DEFAULTS };

function init(userDataDir) {
    filePath = path.join(userDataDir, "settings.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        // Merge over defaults so a settings file written by an older version
        // still gets any newly added keys.
        current = { ...DEFAULTS, ...parsed };
    } catch {
        current = { ...DEFAULTS };
    }
    return current;
}

const getAll = () => ({ ...current });
const get = (key) => current[key];

function set(patch) {
    const allowed = Object.keys(DEFAULTS);
    for (const [k, v] of Object.entries(patch || {})) {
        if (allowed.includes(k)) current[k] = v;
    }
    save();
    return getAll();
}

function save() {
    if (!filePath) return;
    try {
        fs.writeFileSync(filePath, JSON.stringify(current, null, 2), "utf8");
    } catch (e) {
        logger.warn("Could not save settings", { error: e.message });
    }
}

function reset() {
    current = { ...DEFAULTS };
    save();
    return getAll();
}

module.exports = { init, get, getAll, set, reset, DEFAULTS };
