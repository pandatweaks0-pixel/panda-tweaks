"use strict";

// Scoring is pure, so it is tested against fixtures rather than a real machine.

const test = require("node:test");
const assert = require("node:assert");
const { computeScores, scale } = require("../src/main/scores");

const healthy = {
    windows: { build: 26100, uptimeHours: 12 },
    cpu: { name: "Test CPU", cores: 8, threads: 16 },
    gpus: [{ name: "NVIDIA GeForce RTX 4060", currentRefresh: 240, maxRefresh: 240, driverAgeDays: 20 }],
    ram: { totalGB: 32, ratedMHz: 3600, configuredMHz: 3600 },
    drives: [{ letter: "C:", totalGB: 1000, freeGB: 500, freePct: 50 }],
    systemDriveType: "SSD",
    secureBoot: true,
    uac: { enabled: true },
    defender: { available: true, realtimeEnabled: true, tamperProtection: true, signatureAgeDays: 0 },
    firewall: true,
    hvci: 1,
    windowsUpdate: { serviceStartMode: "Manual" },
    gameMode: true,
    gameDvr: false,
    hags: 2,
    powerPlan: { name: "High performance", guid: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c" },
    privacy: {
        telemetryLevel: 0,
        diagTrackStart: "Disabled",
        advertisingId: 0,
        tailoredExperience: 0,
        silentAppInstall: 0,
        startSuggestions: 0,
        activityFeed: 0,
    },
    installedApps: new Array(25).fill({ name: "x" }),
    xboxApps: [],
    components: { oneDriveInstalled: false, copilotPresent: false },
    startup: new Array(4).fill({ name: "x" }),
    scheduledTaskCount: 100,
};

test("a fully healthy system scores 100 everywhere", () => {
    const s = computeScores(healthy);
    for (const key of ["performance", "privacy", "debloat", "gaming", "security"]) {
        assert.equal(s[key].score, 100, `${key} should be 100`);
    }
    assert.equal(s.overall, 100);
});

test("a specific weakness lowers only the category it belongs to", () => {
    const s = computeScores({ ...healthy, defender: { available: true, realtimeEnabled: false, tamperProtection: true, signatureAgeDays: 0 } });
    assert.ok(s.security.score < 100, "security must drop when real-time protection is off");
    assert.equal(s.privacy.score, 100, "privacy is unaffected by a Defender setting");

    const failed = s.security.checks.find((c) => c.id === "defenderRealtime");
    assert.equal(failed.status, "poor");
    assert.equal(failed.detail, "Off");
});

test("unreadable values are excluded from the score, not counted as failures", () => {
    // secureBoot null means "could not determine" — it must not be scored as 0.
    const withUnknown = computeScores({ ...healthy, secureBoot: null });
    assert.equal(withUnknown.security.score, 100);
    assert.equal(withUnknown.security.measured, withUnknown.security.total - 1);

    const withFailure = computeScores({ ...healthy, secureBoot: false });
    assert.ok(withFailure.security.score < 100, "an actual false must lower the score");
});

test("an empty analysis yields null scores instead of zeros or a crash", () => {
    const s = computeScores({});
    for (const key of ["performance", "privacy", "debloat", "gaming", "security"]) {
        assert.equal(s[key].score, null, `${key}: no data means no score, not 0/100`);
        assert.equal(s[key].measured, 0, `${key}: nothing should count as measured`);
    }
    assert.equal(s.overall, null);
});

test("a missing section is unknown, but a value absent within a section is a finding", () => {
    // No privacy section at all -> nothing to score.
    assert.equal(computeScores({ ...healthy, privacy: undefined }).privacy.score, null);

    // Section present but the registry values are not configured -> Windows
    // defaults are in effect, which is a real (poor) result, not "unknown".
    const unconfigured = computeScores({ ...healthy, privacy: {} });
    assert.equal(unconfigured.privacy.score, 0);

    // The one exception is diagTrack: it reads a service start type, so a
    // missing reading genuinely means "could not read", not "default applies".
    const byId = new Map(unconfigured.privacy.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("diagTrack").status, "unknown");
    for (const id of ["telemetry", "advertisingId", "tailored", "silentApps", "suggestions", "activityFeed"]) {
        assert.equal(byId.get(id).status, "poor", `${id} should be a finding, not unknown`);
    }
});

test("a missing gaming reading is not counted as a pass", () => {
    const s = computeScores({ ...healthy, gameDvr: undefined });
    const check = s.gaming.checks.find((c) => c.id === "gameDvr");
    assert.equal(check.status, "unknown", "an unread Game DVR state must not score as good");
    assert.equal(s.gaming.measured, s.gaming.total - 1);
});

test("malformed input does not throw", () => {
    assert.doesNotThrow(() => computeScores(null));
    assert.doesNotThrow(() => computeScores({ gpus: "not an array", drives: 42, ram: "nope" }));
});

test("every check reports its own contribution", () => {
    const s = computeScores(healthy);
    for (const check of s.security.checks) {
        assert.ok(check.label, "check needs a human label");
        assert.ok(check.weight > 0, "check needs a weight");
        assert.ok(["good", "fair", "poor", "unknown"].includes(check.status));
    }
    // The weights are what makes the number reproducible by hand.
    const total = s.security.checks.reduce((a, c) => a + c.weight, 0);
    assert.equal(total, 20);
});

test("scale() clamps and handles both directions", () => {
    assert.equal(scale(25, 5, 25), 1); // more free space is better
    assert.equal(scale(5, 5, 25), 0);
    assert.equal(scale(100, 5, 25), 1, "clamped at the top");
    assert.equal(scale(0, 15, 4), 1, "fewer startup entries is better");
    assert.equal(scale(15, 15, 4), 0);
    assert.equal(scale(null, 0, 1), null);
});

test("power plan is judged by GUID, not by its localized name", () => {
    const saver = computeScores({ ...healthy, powerPlan: { name: "Energiesparmodus", guid: "a1841308-3541-4fab-bc81-f71556f20b4a" } });
    const balanced = computeScores({ ...healthy, powerPlan: { name: "Ausbalanciert", guid: "381b4222-f694-41f0-9685-ff5bb260df2e" } });
    assert.ok(saver.gaming.score < balanced.gaming.score);
    assert.ok(balanced.gaming.score < 100);
});
