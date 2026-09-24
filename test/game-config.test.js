"use strict";

// Editing a game's own ini file. The file belongs to the game and is full of
// unrelated settings, so the tests that matter are the ones proving the edit is
// surgical. Nothing here touches a real game configuration: iniWrite is pure,
// and the live test only reads.

const test = require("node:test");
const assert = require("node:assert");
const {
    OPS,
    validateOp,
    GAME_CONFIGS,
    GAME_SETTINGS,
    iniRead,
    iniWrite,
    runningBlockers,
    processIsRunning,
} = require("../src/main/ops");

const gc = OPS.gameConfig;
const makeOp = (game, setting) => validateOp({ type: "gameConfig", game, setting });

// A miniature of the real file: CRLF, several sections, keys with the same name
// in different sections, and long unrelated values.
const SAMPLE = [
    "[/Script/FortniteGame.FortGameUserSettings]",
    "ResolutionSizeX=1680",
    "ResolutionSizeY=1050",
    "LastConfirmedFullscreenMode=1",
    "PreferredFullscreenMode=1",
    "FrameRateLimit=240.000000",
    'GlobalConfigData=(("HasSeenPassUpsellTest", (Value="true",LastAccessed=2026.09.18-20.15.54)))',
    "",
    "[ScalabilityGroups]",
    "sg.ViewDistanceQuality=0",
    "PreferredFullscreenMode=9",
    "",
    "[D3DRHIPreference]",
    "bUseD3D12InGame=False",
    "",
].join("\r\n");

const SECTION = "/Script/FortniteGame.FortGameUserSettings";

test("only known games and settings become an operation", () => {
    assert.throws(() => makeOp("valorant", "exclusiveFullscreen"), /Unknown game/);
    assert.throws(() => makeOp("retrac", "unlockEverything"), /Unknown game setting/);
    // A tweak may not name a file of its own.
    assert.throws(() => validateOp({ type: "gameConfig", file: "C:\\x.ini", setting: "exclusiveFullscreen" }), /Unknown game/);
});

test("every game names a file and a process, every setting a section", () => {
    for (const [id, g] of Object.entries(GAME_CONFIGS)) {
        assert.match(g.file, /\.ini$/i, `${id} does not point at an ini`);
        assert.ok(g.process && g.process.endsWith(".exe"), `${id} has no process to check`);
        assert.ok(g.label, `${id} has no label`);
    }
    for (const [id, s] of Object.entries(GAME_SETTINGS)) {
        assert.ok(s.section, `${id} has no section`);
        assert.ok(Object.keys(s.entries).length > 0, `${id} sets nothing`);
    }
});

test("reading finds the key inside its own section and nowhere else", () => {
    assert.equal(iniRead(SAMPLE, SECTION, "PreferredFullscreenMode"), "1");
    assert.equal(iniRead(SAMPLE, "ScalabilityGroups", "PreferredFullscreenMode"), "9");
    assert.equal(iniRead(SAMPLE, SECTION, "NotThere"), null);
    assert.equal(iniRead(SAMPLE, "NoSuchSection", "PreferredFullscreenMode"), null);
});

// The bug this guards against: rewriting the file instead of one line, or
// hitting a same-named key in a different section.
test("writing changes one line and leaves every other byte alone", () => {
    const out = iniWrite(SAMPLE, SECTION, "PreferredFullscreenMode", "0");
    assert.equal(iniRead(out, SECTION, "PreferredFullscreenMode"), "0");
    // The identically named key in the other section must not move.
    assert.equal(iniRead(out, "ScalabilityGroups", "PreferredFullscreenMode"), "9");
    // Everything else survives, including the awkward value with brackets.
    assert.equal(iniRead(out, SECTION, "ResolutionSizeX"), "1680");
    assert.equal(iniRead(out, SECTION, "FrameRateLimit"), "240.000000");
    assert.equal(iniRead(out, "D3DRHIPreference", "bUseD3D12InGame"), "False");
    assert.ok(out.includes("HasSeenPassUpsellTest"), "dropped an unrelated value");
    assert.equal(SAMPLE.split(/\r\n/).length, out.split(/\r\n/).length, "changed the number of lines");
});

test("the file keeps the line endings it came with", () => {
    const crlf = iniWrite(SAMPLE, SECTION, "PreferredFullscreenMode", "0");
    assert.ok(crlf.includes("\r\n"), "lost the CRLF endings Unreal writes");
    assert.equal(/[^\r]\n/.test(crlf), false, "produced a mix of CRLF and LF");

    const lf = iniWrite(SAMPLE.replace(/\r\n/g, "\n"), SECTION, "PreferredFullscreenMode", "0");
    assert.equal(lf.includes("\r\n"), false, "added CRLF to a file that had none");
});

test("a missing key is added under its section, a missing section is refused", () => {
    const added = iniWrite(SAMPLE, SECTION, "NewKey", "7");
    assert.equal(iniRead(added, SECTION, "NewKey"), "7");
    // It must land in the right section, not at the end of the file.
    assert.equal(iniRead(added, "ScalabilityGroups", "NewKey"), null);
    // Inventing a section in someone else's config would be a guess.
    assert.equal(iniWrite(SAMPLE, "MadeUpSection", "Key", "1"), null);
});

test("a game that is not installed is unknown, and nothing is written for it", async () => {
    const op = makeOp("retrac", "exclusiveFullscreen");
    const absent = { readFailed: false, missing: true };
    assert.equal(gc.isApplied(op, absent), null);
    assert.equal(gc.isApplied(op, { readFailed: true }), null);
    assert.equal(gc.isApplied(op, null), null);
    assert.equal((await gc.apply(op, absent)).ok, false);
    assert.match((await gc.apply(op, absent)).error, /not installed/);
    assert.equal((await gc.restore(op, absent)).ok, true);
    assert.match((await gc.restore(op, { readFailed: true })).error, /cannot undo safely/);
});

test("applied means every key agrees, not just the first", () => {
    const op = makeOp("retrac", "exclusiveFullscreen");
    const snap = (a, b) => ({ readFailed: false, missing: false, previous: { PreferredFullscreenMode: a, LastConfirmedFullscreenMode: b } });
    assert.equal(gc.isApplied(op, snap("0", "0")), true);
    // Unreal reverts to the "last confirmed" copy, so half is not applied.
    assert.equal(gc.isApplied(op, snap("0", "1")), false);
    assert.equal(gc.isApplied(op, snap("1", "0")), false);
    assert.equal(gc.isApplied(op, snap(null, null)), false);
});

test("it needs no administrator rights and can be undone", () => {
    assert.equal(gc.requiresAdmin(makeOp("retrac", "exclusiveFullscreen")), false);
    assert.equal(gc.undoable, true);
});

// The apply flow stops the whole run when one of these is open, so a wrong
// answer either blocks everything for no reason or lets the change be thrown
// away silently. Both directions are checked against the real system.
test("a running process is recognised, an absent one is not", () => {
    // explorer.exe is running on any Windows session that has a desktop.
    assert.equal(processIsRunning("explorer.exe"), true);
    assert.equal(processIsRunning("this-program-does-not-exist-12345.exe"), false);
    // tasklist answers in the system language, so the check must not depend on
    // parsing its "no tasks found" sentence.
    assert.equal(processIsRunning(""), false);
});

test("only operations that declare a blocker are asked about", () => {
    // A registry tweak has nothing to close, so it never blocks a run.
    const reg = validateOp({
        type: "registry",
        hive: "HKCU",
        key: "Software\\PandaTweaks",
        name: "X",
        valueType: "REG_DWORD",
        value: "1",
    });
    assert.deepEqual(runningBlockers([reg]), []);
    assert.deepEqual(runningBlockers([]), []);
    assert.deepEqual(runningBlockers(null), []);

    // The game config operation declares one, whether or not it is open now.
    const gcOp = makeOp("retrac", "exclusiveFullscreen");
    const declared = OPS.gameConfig.blockedBy(gcOp);
    assert.equal(declared.process, GAME_CONFIGS.retrac.process);
    assert.ok(declared.label);
    // Whatever the answer is, it must match what the process check says.
    assert.equal(runningBlockers([gcOp]).length, processIsRunning(declared.process) ? 1 : 0);
});

test("capture reads the real file without changing it", async () => {
    const fsNode = require("node:fs");
    const op = makeOp("retrac", "exclusiveFullscreen");
    const file = GAME_CONFIGS.retrac.file.replace(/%([^%]+)%/g, (m, n) => process.env[n] || m);
    const before = fsNode.existsSync(file) ? fsNode.readFileSync(file) : null;

    const cur = (await gc.capture([op])).get(op);
    assert.ok(cur, "no snapshot");
    if (cur.missing) {
        assert.equal(gc.isApplied(op, cur), null);
    } else if (!cur.readFailed) {
        assert.equal(typeof cur.previous, "object");
        assert.ok(cur.file, "read a value without recording which file it came from");
    }
    if (before) assert.deepEqual(fsNode.readFileSync(file), before, "capture modified the configuration");
});
