"use strict";

// The registryScan operation: one value written to every device of a known
// kind. These tests use fabricated snapshots, so nothing here reads or writes a
// real device key — the one exception is the last test, which runs the real
// enumeration read-only to prove the scopes still match this Windows build.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { OPS, validateOp, SCAN_SCOPES, SCAN_SETTINGS, scanKeyAllowed } = require("../src/main/ops");
const { runPsJson } = require("../src/main/shell");

const scan = OPS.registryScan;
const makeOp = (setting, value) => validateOp({ type: "registryScan", setting, value });

// A snapshot as capture() would build it.
const snap = (targets) => ({ readFailed: false, targets });
const target = (key, value) => ({ key, readFailed: false, exists: value !== null, valueType: "REG_DWORD", value });

test("a device setting outside the allowlist never becomes an operation", () => {
    assert.throws(() => makeOp("deleteEverything", 1), /Unknown device setting/);
    // The table is the whole vocabulary: a tweak cannot describe a path.
    assert.throws(
        () => validateOp({ type: "registryScan", key: "SYSTEM\\CurrentControlSet", name: "X", value: 1 }),
        /Unknown device setting/
    );
});

test("a missing value is rejected rather than silently becoming zero", () => {
    for (const bad of [undefined, null, "", "  ", "yes", 1.5, -1, 0x1_0000_0000]) {
        assert.throws(() => makeOp("gpuMsi", bad), /Invalid device setting value/, `accepted ${bad}`);
    }
    assert.equal(makeOp("gpuMsi", 1).value, "1");
    assert.equal(makeOp("usbInputEpm", 0).value, "0");
});

test("every setting points at a scope that exists", () => {
    for (const [id, s] of Object.entries(SCAN_SETTINGS)) {
        assert.ok(SCAN_SCOPES[s.scope], `${id} names an unknown scope`);
        assert.ok(s.name, `${id} has no value name`);
    }
});

// The scan reads paths off the machine and this operation then writes to them.
// Without this check a surprising registry layout becomes a write anywhere.
test("a key outside its scope's root is refused", () => {
    const root = SCAN_SCOPES.audioRender.root;
    assert.equal(scanKeyAllowed("audioRender", root + "\\{guid}"), true);
    assert.equal(scanKeyAllowed("audioRender", root.toUpperCase() + "\\{guid}"), true);
    assert.equal(scanKeyAllowed("audioRender", "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run"), false);
    assert.equal(scanKeyAllowed("audioRender", root + "\\..\\..\\Run"), false);
    assert.equal(scanKeyAllowed("gpu", "SYSTEM\\CurrentControlSet\\Services\\Tcpip"), false);
    // A prefix that only looks like the root must not pass.
    assert.equal(scanKeyAllowed("tcpInterfaces", SCAN_SCOPES.tcpInterfaces.root + "Evil"), false);
});

test("applied means every device, not the first one", () => {
    const op = makeOp("usbInputEpm", 0);
    assert.equal(scan.isApplied(op, snap([target("a", "0"), target("b", "0")])), true);
    assert.equal(scan.isApplied(op, snap([target("a", "0"), target("b", "1")])), false);
    // Absent is not zero: the value has to actually be there.
    assert.equal(scan.isApplied(op, snap([target("a", "0"), target("b", null)])), false);
    // 0x0 read back must compare equal to a declared 0.
    assert.equal(scan.isApplied(op, snap([target("a", "0x0")])), true);
});

test("a device that could not be read makes the verdict unknown, not 'no'", () => {
    const op = makeOp("btEpm", 0);
    assert.equal(scan.isApplied(op, { readFailed: true }), null);
    assert.equal(scan.isApplied(op, snap([target("a", "0"), { key: "b", readFailed: true }])), null);
    assert.equal(scan.isApplied(op, null), null);
});

test("no devices of that kind counts as nothing left to do", async () => {
    const op = makeOp("btEpm", 0);
    // Otherwise a PC without Bluetooth is offered the Bluetooth tweak forever.
    assert.equal(scan.isApplied(op, snap([])), true);
    const res = await scan.apply(op, snap([]));
    assert.equal(res.ok, true);
    assert.match(res.warning, /nothing to change/i);
    assert.equal(scan.explain(op, snap([])).now, "no such devices on this PC");
});

test("nothing is applied or undone without a captured state", async () => {
    const op = makeOp("gpuMsi", 1);
    assert.equal((await scan.apply(op, { readFailed: true, error: "scan failed" })).ok, false);
    assert.equal((await scan.restore(op, { readFailed: true })).ok, false);
    assert.match((await scan.restore(op, null)).error, /cannot undo safely/);
});

test("explain() counts the devices already set, and stays null when unread", () => {
    const op = makeOp("audioExclusive", 0);
    assert.equal(scan.explain(op, snap([target("a", "0"), target("b", "1"), target("c", null)])).now, "1 of 3 already set");
    assert.equal(scan.explain(op, { readFailed: true }).now, null);
});

test("describe() says it hits every device, before anything runs", () => {
    const text = scan.describe(makeOp("usbInputEpm", 0));
    assert.match(text, /EnhancedPowerManagementEnabled/);
    assert.match(text, /every one of the USB keyboards and mice/);
});

test("all of it needs administrator rights", () => {
    for (const id of Object.keys(SCAN_SETTINGS)) {
        assert.equal(scan.requiresAdmin(makeOp(id, 0)), true, id);
    }
    assert.equal(scan.undoable, true);
});

// The scopes are hand-written registry layouts, and Windows moves things. This
// is the test that fails when a path stops being real — the original audio
// tweaks were pointed at a key that does not exist on any Windows build, and
// nothing noticed because the errors were suppressed.
test("every scope still resolves on this Windows build", async () => {
    const scopes = Object.keys(SCAN_SCOPES);
    const res = await runPsJson(path.join(__dirname, "..", "src", "main", "ps", "scan-registry.ps1"), { scopes }, null);
    assert.ok(res.ok, `scan script failed: ${res.error}`);
    for (const s of scopes) {
        assert.ok(res.data[s], `${s} missing from the scan output`);
        assert.equal(res.data[s].ok, true, `${s} could not be enumerated`);
        for (const key of res.data[s].keys) {
            assert.ok(scanKeyAllowed(s, key), `${s} returned a key outside its root: ${key}`);
        }
    }
    // Not every PC has Bluetooth, but every PC has a graphics adapter, a
    // playback device and network interfaces.
    for (const s of ["gpu", "audioRender", "tcpInterfaces"]) {
        assert.ok(res.data[s].keys.length > 0, `${s} found nothing on this machine`);
    }
});

test("an unknown scope reports failure rather than an empty list", async () => {
    const res = await runPsJson(
        path.join(__dirname, "..", "src", "main", "ps", "scan-registry.ps1"),
        { scopes: ["notAScope"] },
        null
    );
    assert.ok(res.ok);
    assert.equal(res.data.notAScope.ok, false);
    assert.deepEqual(res.data.notAScope.keys, []);
});
