"use strict";

// The toggle operation: Windows switches with no registry value behind them.
// Nothing here changes a setting — the last test reads, and reading these needs
// administrator rights, which is itself what it checks.

const test = require("node:test");
const assert = require("node:assert");
const { OPS, validateOp, TOGGLES, COMMANDS } = require("../src/main/ops");

const toggle = OPS.toggle;
const makeOp = (setting, enabled) => validateOp({ type: "toggle", setting, enabled });

test("a toggle outside the allowlist never becomes an operation", () => {
    assert.throws(() => makeOp("disableDefender", false), /Unknown Windows toggle/);
    assert.throws(() => validateOp({ type: "toggle", enabled: false }), /Unknown Windows toggle/);
});

// "off" and "not stated" are different, and Number/Boolean coercion is exactly
// how they stop being different.
test("enabled has to be a real boolean", () => {
    for (const bad of [undefined, null, "", "false", "off", 0, 1]) {
        assert.throws(() => makeOp("memoryCompression", bad), /enabled: true or false/, `accepted ${bad}`);
    }
    assert.equal(makeOp("memoryCompression", false).enabled, false);
    assert.equal(makeOp("memoryCompression", true).enabled, true);
});

test("every toggle has both directions, so it can always be undone", () => {
    for (const [id, spec] of Object.entries(TOGGLES)) {
        assert.ok(Array.isArray(spec.on) && spec.on.length, `${id} has no "on" arguments`);
        assert.ok(Array.isArray(spec.off) && spec.off.length, `${id} has no "off" arguments`);
        assert.notDeepEqual(spec.on, spec.off, `${id} switches the same way in both directions`);
        assert.ok(spec.file, `${id} names no executable`);
    }
    assert.equal(toggle.undoable, true);
    assert.equal(toggle.requiresAdmin(makeOp("memoryCompression", false)), true);
});

test("a state that could not be read is unknown, never 'already off'", () => {
    const op = makeOp("memoryCompression", false);
    assert.equal(toggle.isApplied(op, null), null);
    assert.equal(toggle.isApplied(op, { readFailed: true }), null);
    assert.equal(toggle.isApplied(op, { readFailed: false, enabled: false }), true);
    assert.equal(toggle.isApplied(op, { readFailed: false, enabled: true }), false);
    assert.equal(toggle.explain(op, { readFailed: true }).now, null);
    assert.equal(toggle.explain(op, { readFailed: false, enabled: true }).now, "On");
});

test("nothing is switched without a captured state", async () => {
    const op = makeOp("reservedStorage", false);
    const failed = { readFailed: true, error: "needs administrator rights" };
    assert.equal((await toggle.apply(op, failed)).ok, false);
    // The one that matters: undo with no snapshot must not guess a direction.
    assert.match((await toggle.restore(op, failed)).error, /cannot undo safely/);
    assert.match((await toggle.restore(op, null)).error, /cannot undo safely/);
});

test("describe() says which way it goes, before anything runs", () => {
    assert.equal(toggle.describe(makeOp("memoryCompression", false)), "Turn Memory compression off");
    assert.equal(toggle.describe(makeOp("reservedStorage", true)), "Turn Reserved storage on");
});

test("the two new one-time commands are on the fixed table, with argument arrays", () => {
    for (const id of ["emptyRecycleBin", "clearEventLogs"]) {
        const spec = COMMANDS[id];
        assert.ok(spec, `${id} is missing`);
        assert.ok(Array.isArray(spec.args), `${id} does not use an argument array`);
        assert.ok(spec.label, `${id} has no label`);
    }
    // Clearing logs touches machine-wide state; emptying the bin does not.
    assert.equal(COMMANDS.clearEventLogs.admin, true);
    assert.equal(COMMANDS.emptyRecycleBin.admin, false);
    assert.equal(OPS.command.undoable, false);
});

test("reading a toggle either works or reports why, and never invents a value", async () => {
    const ops = [makeOp("memoryCompression", false), makeOp("reservedStorage", false)];
    const cur = await toggle.capture(ops);
    for (const op of ops) {
        const c = cur.get(op);
        assert.ok(c, `${op.setting} produced no snapshot`);
        if (c.readFailed) {
            // Unelevated is the normal case: the app starts without admin.
            assert.ok(c.error, `${op.setting} failed without saying why`);
            assert.equal(toggle.isApplied(op, c), null);
        } else {
            assert.equal(typeof c.enabled, "boolean", `${op.setting} read a non-boolean`);
        }
    }
});
