"use strict";

// Operations layer. The registry tests write to a throwaway key under HKCU, so
// they need no elevation and touch nothing real.

const test = require("node:test");
const assert = require("node:assert");
const { OPS, validateOp, normalizeRegValue, isProtectedPackage, regWriteError } = require("../src/main/ops");
const { run } = require("../src/main/shell");

const KEY = "Software\\PandaTweaks\\__test__";
const reg = OPS.registry;

const makeOp = (name, extra = {}) =>
    validateOp({ type: "registry", hive: "HKCU", key: KEY, name, valueType: "REG_DWORD", value: "1", ...extra });

const readState = async (op) => (await reg.capture([op])).get(op);

test.after(async () => {
    await run("reg.exe", ["delete", `HKCU\\Software\\PandaTweaks`, "/f"]);
});

test("undo deletes a value that did not exist before", async () => {
    const op = makeOp("FreshValue");

    const before = await readState(op);
    assert.equal(before.exists, false, "test key should start clean");

    assert.equal((await reg.apply(op)).ok, true);
    const after = await readState(op);
    assert.equal(after.exists, true);
    assert.equal(after.value, "1");

    // The whole point of snapshot-based undo: the value was absent, so undo has
    // to remove it rather than write an assumed Windows default.
    assert.equal((await reg.restore(op, before)).ok, true);
    assert.equal((await readState(op)).exists, false);
});

test("undo restores the user's own previous value, not a default", async () => {
    const seed = validateOp({
        type: "registry",
        hive: "HKCU",
        key: KEY,
        name: "MenuShowDelay",
        valueType: "REG_SZ",
        value: "200", // a value the user chose; Windows' default is 400
    });
    await reg.apply(seed);

    const tweak = validateOp({ ...seed, value: "0" });
    const before = await readState(tweak);
    assert.equal(before.value, "200");

    await reg.apply(tweak);
    assert.equal((await readState(tweak)).value, "0");

    assert.equal((await reg.restore(tweak, before)).ok, true);
    assert.equal((await readState(tweak)).value, "200", "must restore 200, not the 400 default");
});

test("a failed read is never treated as 'value absent'", async () => {
    const op = makeOp("Whatever");
    const result = await reg.restore(op, { readFailed: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /cannot undo safely/i);
});

test("isApplied reports unknown rather than false when state is unreadable", () => {
    const op = makeOp("Whatever");
    assert.equal(reg.isApplied(op, { readFailed: true }), null);
    assert.equal(reg.isApplied(op, { exists: false }), false);
    assert.equal(reg.isApplied(op, { exists: true, value: "1", valueType: "REG_DWORD" }), true);
});

test("DWORD values compare equal across hex and decimal notation", () => {
    assert.equal(normalizeRegValue("REG_DWORD", "0x1"), "1");
    assert.equal(normalizeRegValue("REG_DWORD", "1"), "1");
    assert.equal(normalizeRegValue("REG_DWORD", "0x0000000a"), "10");
    assert.equal(normalizeRegValue("REG_BINARY", "AA BB"), "aabb");
    assert.equal(normalizeRegValue("REG_SZ", "Text"), "Text");
});

test("validation rejects malformed operations instead of passing them through", () => {
    assert.throws(() => validateOp({ type: "registry", hive: "HKXX", key: "a", name: "b" }), /hive/i);
    assert.throws(() => validateOp({ type: "registry", hive: "HKCU", key: "", name: "b" }), /key/i);
    assert.throws(
        () => validateOp({ type: "registry", hive: "HKCU", key: 'a"b', name: "c", value: "1" }),
        /key/i
    );
    assert.throws(
        () => validateOp({ type: "registry", hive: "HKCU", key: "a", name: "b", valueType: "REG_NOPE", value: "1" }),
        /type/i
    );
    assert.throws(() => validateOp({ type: "service", name: "bad name!", startMode: "disabled" }), /service name/i);
    assert.throws(() => validateOp({ type: "service", name: "Spooler", startMode: "sideways" }), /start mode/i);
    assert.throws(() => validateOp({ type: "scheduledTask", path: "no-leading-slash" }), /task path/i);
    assert.throws(() => validateOp({ type: "cleanup", target: "C:\\Windows" }), /cleanup target/i);
    assert.throws(() => validateOp({ type: "nonsense" }), /Unknown operation type/i);
});

test("unsupported operations fail validation with their own reason", () => {
    assert.throws(
        () => validateOp({ type: "unsupported", command: "powercfg -x", reason: "powercfg is not implemented yet" }),
        /powercfg is not implemented yet/
    );
});

test("system-critical Store packages can never be removed", () => {
    for (const name of [
        "Microsoft.WindowsStore",
        "Microsoft.DesktopAppInstaller",
        "Microsoft.VCLibs.140.00",
        "Microsoft.SecHealthUI",
        "Microsoft.AAD.BrokerPlugin",
    ]) {
        assert.equal(isProtectedPackage(name), true, `${name} must be protected`);
        assert.throws(() => validateOp({ type: "appx", package: name }), /system-critical/i);
    }
    assert.equal(isProtectedPackage("Microsoft.BingNews"), false);
});

test("describe() states the exact target before anything runs", () => {
    assert.equal(
        reg.describe(makeOp("GameDVR_Enabled", { value: "0" })),
        `Set registry value HKCU\\${KEY}\\GameDVR_Enabled = 0 (REG_DWORD)`
    );
    assert.equal(
        OPS.service.describe(validateOp({ type: "service", name: "DiagTrack", startMode: "disabled" })),
        'Set service "DiagTrack" start type to disabled and stop it'
    );
});

// A blanket scan skips operation types that declare themselves undetectable.
// This flag has to be stated on the handler: probing for it by calling
// isApplied(op, null) silently classifies EVERY type as undetectable, because
// a null reading is exactly what a failed read looks like.
test("only actions without a readable state opt out of detection", () => {
    const opted = Object.entries(OPS)
        .filter(([, handler]) => handler.detectable === false)
        .map(([type]) => type)
        .sort();

    // cleanup: reading costs a full directory walk and answers nothing.
    // command: running a repair tool has no state to compare against at all.
    assert.deepEqual(opted, ["cleanup", "command"]);
    assert.notEqual(OPS.service.detectable, false, "service state is readable without admin — it must be scanned");
    assert.notEqual(OPS.registry.detectable, false);
});

// A cleanup target that could not be opened must not be reported as an empty
// one. Prefetch needs administrator rights to read: as a standard user the walk
// finds nothing there, and calling that "0 B, nothing to free" would be a lie
// the user acts on.
test("an unreadable cleanup target reports nothing, not zero", () => {
    const op = validateOp({ type: "cleanup", target: "prefetch" });

    const PREFETCH = "C:\\Windows\\Prefetch";

    const unreadable = OPS.cleanup.explain(op, { root: PREFETCH, files: [], bytes: 0, blocked: [PREFETCH], readFailed: true });
    assert.equal(unreadable.now, null, "unreadable must stay unknown");

    const empty = OPS.cleanup.explain(op, { root: PREFETCH, files: [], bytes: 0, blocked: [], readFailed: false });
    assert.match(empty.now, /0 files/, "genuinely empty is a real, reportable answer");

    const partial = OPS.cleanup.explain(op, { root: "x", files: [{ size: 10 }], bytes: 10, blocked: ["x\\sub"], readFailed: false });
    assert.match(partial.note, /1 subfolders unreadable/, "a partial read says so instead of implying a complete count");
});

// Disabling an autostart entry must not delete it. Windows keeps the Run value
// and records the decision in a separate approval marker; anything else would
// make "undo" a reinstall rather than a restore. This writes its own throwaway
// Run value under HKCU, so it needs no elevation and touches nothing real.
test("disabling an autostart entry keeps the Run value and can be undone", async () => {
    const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const NAME = "PandaTweaksSelfTest";
    const startup = OPS.startup;

    await run("reg.exe", ["add", RUN, "/v", NAME, "/t", "REG_SZ", "/d", "C:\\panda-test.exe", "/f"]);
    try {
        const off = validateOp({ type: "startup", name: NAME, scope: "hkcuRun", enabled: false });

        const before = (await startup.capture([off])).get(off);
        assert.equal(before.exists, true, "the fresh Run value should be visible");
        assert.equal(before.enabled, true, "an entry with no marker counts as enabled");

        assert.equal((await startup.apply(off)).ok, true);
        const afterDisable = (await startup.capture([off])).get(off);
        assert.equal(afterDisable.enabled, false);
        assert.equal(afterDisable.exists, true, "disabling must never remove the entry itself");

        // The Run value has to survive verbatim — that is the whole point.
        const reg = await run("reg.exe", ["query", RUN, "/v", NAME]);
        assert.match(reg.stdout, /panda-test\.exe/);

        assert.equal((await startup.restore(off, before)).ok, true);
        assert.equal((await startup.capture([off])).get(off).enabled, true, "undo restores the captured state");
    } finally {
        await run("reg.exe", ["delete", RUN, "/v", NAME, "/f"]);
        await run("reg.exe", [
            "delete",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
            "/v",
            NAME,
            "/f",
        ]);
    }
});


// "Access denied" from reg.exe means two different things, and telling them
// apart is the whole answer for the user. Under HKLM it means "run as
// administrator". Under HKCU it cannot mean that — the hive belongs to the
// user — so it means Windows protects that particular value on this build, and
// elevating changes nothing. Reported as a bare failure, it looks like a bug in
// this app and gets retried forever.
test("access denied is explained differently per hive", () => {
    const denied = { stderr: "FEHLER: Zugriff verweigert", stdout: "", code: 1 };

    const user = regWriteError({ hive: "HKCU", name: "TaskbarDa" }, denied);
    assert.match(user, /protects this value/i);
    assert.match(user, /TaskbarDa/, "name the value, so the user can look it up");
    assert.doesNotMatch(user, /administrator rights/i, "elevation is not the answer here");

    const machine = regWriteError({ hive: "HKLM", name: "Something" }, denied);
    assert.match(machine, /administrator/i);
});

test("errors that are not access denied are passed through untouched", () => {
    const other = regWriteError({ hive: "HKCU", name: "X" }, { stderr: "ERROR: Invalid syntax", code: 1 });
    assert.equal(other, "ERROR: Invalid syntax", "do not dress up an error we did not diagnose");
});

// A service that this edition of Windows never installed used to be reported as
// a failure, and that failure could not be escaped: serviceIsApplied answers
// "unknown" for an absent service, so the tweak never counted as applied, the
// card stayed selectable, and the next apply produced the identical error.
// sc.exe error 1060 for every attempt, for ever.
test("a service that is not installed is nothing to do, not a failure", async () => {
    const svc = OPS.service;
    const op = validateOp({ type: "service", name: "PandaTweaksNoSuchService", startMode: "disabled" });

    // What capture reports for a service that is not there.
    const absent = { exists: false, startMode: "", state: "", display: "" };

    const res = await svc.apply(op, absent);
    assert.equal(res.ok, true, "an absent service is already as stopped as it can be");
    assert.match(res.warning, /not installed/i, "say why nothing happened");

    // And it has to READ as done, or the card never leaves the recommended
    // list and the user clicks it again tomorrow.
    assert.equal(svc.isApplied(op, absent), true);

    // Turning a service on is the opposite case: absent is not "already
    // running", and claiming otherwise would be a false yes.
    const enable = validateOp({ type: "service", name: "PandaTweaksNoSuchService", startMode: "auto", start: true });
    assert.equal(svc.isApplied(enable, absent), null);

    // Without a capture the handler must not invent one: it still tries, so the
    // appx and autostart paths that share the apply loop keep working.
    const blind = await svc.apply(op, null);
    assert.equal(blind.ok, false, "no captured state means the real attempt still happens");
});

// The counterpart: an unreadable service must not be mistaken for an absent
// one. "I could not look" and "it is not there" lead to opposite actions.
test("an unreadable service is still attempted, not skipped", async () => {
    const svc = OPS.service;
    const op = validateOp({ type: "service", name: "PandaTweaksNoSuchService", startMode: "disabled" });

    const unreadable = { readFailed: true, error: "service read failed" };
    const res = await svc.apply(op, unreadable);
    assert.equal(res.ok, false, "a failed read is not permission to skip the write");
});
