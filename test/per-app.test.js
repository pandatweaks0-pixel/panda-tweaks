"use strict";

// Per-application settings. Nothing here writes: the merge logic is tested on
// plain strings, and the one live test only reads.

const test = require("node:test");
const assert = require("node:assert");
const {
    OPS,
    validateOp,
    APPS,
    APP_SETTINGS,
    findExe,
    perAppWithToken,
    perAppHasToken,
} = require("../src/main/ops");

const perApp = OPS.perApp;
const makeOp = (app, setting) => validateOp({ type: "perApp", app, setting });

const GPU = APP_SETTINGS.gpuHighPerf;
const FSO = APP_SETTINGS.fullscreenOptOff;
const CPU = APP_SETTINGS.cpuPriorityHigh;

test("only known applications and settings become an operation", () => {
    assert.throws(() => makeOp("valorant", "gpuHighPerf"), /Unknown application/);
    assert.throws(() => makeOp("retrac", "disableAntiCheat"), /Unknown per-application setting/);
    // A tweak may not carry a path of its own; the table owns every location.
    assert.throws(() => validateOp({ type: "perApp", exe: "C:\\evil.exe", setting: "gpuHighPerf" }), /Unknown application/);
});

test("every app lists candidate paths and every setting a target", () => {
    for (const [id, app] of Object.entries(APPS)) {
        assert.ok(Array.isArray(app.candidates) && app.candidates.length, `${id} has no candidate paths`);
        assert.ok(app.label, `${id} has no label`);
        for (const c of app.candidates) assert.match(c, /\\/, `${id}: ${c} is not a path`);
    }
    for (const [id, s] of Object.entries(APP_SETTINGS)) {
        assert.ok(["list", "flags", "dword"].includes(s.kind), `${id} has an unknown kind`);
        assert.ok(s.hive && s.key && s.label, `${id} is missing hive, key or label`);
    }
});

// The bug this guards against: replacing the whole value instead of merging.
// Windows keeps other programs' entries in these same two values, and writing
// over them removes settings that were nothing to do with this tweak.
test("adding a flag keeps the flags that were already there", () => {
    const now = "~ HIGHDPIAWARE RUNASADMIN";
    const after = perAppWithToken(FSO, now);
    assert.ok(after.includes("HIGHDPIAWARE"), "dropped HIGHDPIAWARE");
    assert.ok(after.includes("RUNASADMIN"), "dropped RUNASADMIN");
    assert.ok(after.includes("DISABLEDXMAXIMIZEDWINDOWEDMODE"), "did not add its own flag");
    // The compatibility list has exactly one leading "~" marker.
    assert.equal(after.match(/~/g).length, 1);
    assert.equal(after.startsWith("~ "), true);
});

test("a flag is not added twice", () => {
    const once = perAppWithToken(FSO, "~ DISABLEDXMAXIMIZEDWINDOWEDMODE");
    assert.equal(once.match(/DISABLEDXMAXIMIZEDWINDOWEDMODE/g).length, 1);
});

test("the GPU preference replaces only its own key, not the whole list", () => {
    const now = "SwapEffectUpgradeEnable=1;VRROptimizeEnable=1;GpuPreference=1;";
    const after = perAppWithToken(GPU, now);
    assert.ok(after.includes("SwapEffectUpgradeEnable=1"), "dropped SwapEffectUpgradeEnable");
    assert.ok(after.includes("VRROptimizeEnable=1"), "dropped VRROptimizeEnable");
    assert.ok(after.includes("GpuPreference=2"), "did not set the preference");
    assert.equal(after.match(/GpuPreference=/g).length, 1, "left the old preference behind");
});

test("an empty or missing value still produces a valid one", () => {
    assert.ok(perAppWithToken(GPU, "").includes("GpuPreference=2"));
    assert.ok(perAppWithToken(FSO, "").includes("DISABLEDXMAXIMIZEDWINDOWEDMODE"));
    assert.equal(perAppWithToken(CPU, ""), "3");
});

test("detection reads the token out of the value, not the whole string", () => {
    assert.equal(perAppHasToken(FSO, "~ HIGHDPIAWARE DISABLEDXMAXIMIZEDWINDOWEDMODE"), true);
    assert.equal(perAppHasToken(FSO, "~ HIGHDPIAWARE"), false);
    assert.equal(perAppHasToken(GPU, "GpuPreference=2;"), true);
    assert.equal(perAppHasToken(GPU, "GpuPreference=1;"), false);
    assert.equal(perAppHasToken(CPU, "3"), true);
    assert.equal(perAppHasToken(CPU, "0x3"), true); // read back as hex
    assert.equal(perAppHasToken(CPU, "2"), false);
    assert.equal(perAppHasToken(FSO, null), false);
});

test("a program that is not installed is unknown, not 'already applied'", () => {
    const op = makeOp("retrac", "gpuHighPerf");
    assert.equal(perApp.isApplied(op, { readFailed: false, missing: true }), null);
    assert.equal(perApp.isApplied(op, { readFailed: true }), null);
    assert.equal(perApp.isApplied(op, null), null);
    assert.equal(perApp.explain(op, { readFailed: false, missing: true }).now, "not installed");
});

test("nothing is written for a program that is not there", async () => {
    const op = makeOp("retrac", "gpuHighPerf");
    const res = await perApp.apply(op, { readFailed: false, missing: true });
    assert.equal(res.ok, false);
    assert.match(res.error, /not installed/);
    // Undo has nothing to put back and must not invent a write.
    assert.equal((await perApp.restore(op, { readFailed: false, missing: true })).ok, true);
    assert.match((await perApp.restore(op, { readFailed: true })).error, /cannot undo safely/);
});

test("only the priority setting needs administrator rights", () => {
    assert.equal(perApp.requiresAdmin(makeOp("retrac", "cpuPriorityHigh")), true);
    assert.equal(perApp.requiresAdmin(makeOp("retrac", "gpuHighPerf")), false);
    assert.equal(perApp.requiresAdmin(makeOp("retrac", "fullscreenOptOff")), false);
    assert.equal(perApp.undoable, true);
});

test("findExe returns a real file or nothing, never a guess", () => {
    const fs = require("node:fs");
    for (const id of Object.keys(APPS)) {
        const found = findExe(id);
        if (found === null) continue;
        assert.ok(fs.statSync(found).isFile(), `${id} reported a path that is not a file: ${found}`);
        assert.ok(!found.includes("%"), `${id} returned an unexpanded variable: ${found}`);
    }
});

test("capture reports a snapshot for every operation and invents no value", async () => {
    const ops = [makeOp("retrac", "gpuHighPerf"), makeOp("obs", "cpuPriorityHigh")];
    const cur = await perApp.capture(ops);
    for (const op of ops) {
        const c = cur.get(op);
        assert.ok(c, `${op.app} produced no snapshot`);
        if (c.missing) {
            assert.equal(perApp.isApplied(op, c), null);
        } else if (!c.readFailed) {
            assert.equal(typeof c.exists, "boolean");
            assert.ok(c.exe, "read a value without knowing which executable it belongs to");
        }
    }
});
