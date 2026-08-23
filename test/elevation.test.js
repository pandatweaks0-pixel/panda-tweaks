"use strict";

// The relaunch arguments. This is the part that was broken: `electron .` puts a
// bare "." in argv, and an elevated process does not inherit our working
// directory — Windows starts it in system32, where "." is a different place.
// The process started, found no app there, and showed nothing, so the button
// looked dead.
//
// Nothing here spawns anything or raises a prompt.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

// electron is not loadable outside an Electron process, and elevation.js pulls
// it in for app.getAppPath(). The stub keeps this a plain unit test.
require.cache[require.resolve("electron")] = { exports: { app: {} } };
const { buildRelaunch } = require("../src/main/elevation");

const APP = "C:\\Users\\x\\Desktop\\panda tweaks free";
const DEV_EXE = path.join(APP, "node_modules", "electron", "dist", "electron.exe");

test("a relative app path is made absolute before it is handed to the new process", () => {
    const r = buildRelaunch({ execPath: DEV_EXE, argv: ["."], appPath: APP, packaged: false });

    assert.ok(!r.args.includes("."), 'a bare "." must never survive: it resolves against system32');
    assert.ok(r.args.includes(APP), "the app path has to travel as an absolute path");
    assert.equal(r.workingDirectory, APP);
});

test("a development run always carries an app path, even with an empty argv", () => {
    const r = buildRelaunch({ execPath: DEV_EXE, argv: [], appPath: APP, packaged: false });

    assert.ok(r.args.includes(APP), "electron.exe with no app argument opens its default window, not this app");
});

test("the elevated marker is added exactly once", () => {
    const r = buildRelaunch({ execPath: DEV_EXE, argv: [".", "--elevated"], appPath: APP, packaged: false });

    assert.equal(r.args.filter((a) => a === "--elevated").length, 1, "relaunching twice must not stack the flag");
});

test("a packaged build needs no app argument and starts next to its exe", () => {
    const exe = "C:\\Program Files\\Panda Tweaks\\Panda Tweaks.exe";
    const r = buildRelaunch({ execPath: exe, argv: [], appPath: "C:\\Program Files\\Panda Tweaks\\resources\\app.asar", packaged: true });

    assert.deepEqual(r.args, ["--elevated"]);
    assert.equal(r.workingDirectory, path.dirname(exe));
});

test("flags are passed through untouched", () => {
    const r = buildRelaunch({ execPath: DEV_EXE, argv: [".", "--dev"], appPath: APP, packaged: false });

    assert.ok(r.args.includes("--dev"), "a flag is not a path and must not be resolved against anything");
});

// The second half of the same bug. Start-Process joins -ArgumentList with
// spaces and quotes nothing, so "…\panda tweaks free" arrived at Electron as
// three arguments and it looked for an app called "…\panda". The relaunch
// opened an error window instead of the app.
test("an argument containing spaces stays one argument", () => {
    const { psArgumentList } = require("../src/main/elevation");
    const list = psArgumentList([APP, "--elevated"]);

    assert.equal(
        list,
        `'"${APP}"','"--elevated"'`,
        "each argument needs quotes for the child's command line, inside PowerShell's own quoting"
    );
    assert.ok(APP.includes(" "), "this test is only meaningful with a path that has a space in it");
});

test("a single quote in a path cannot end PowerShell's string", () => {
    const { psArgumentList } = require("../src/main/elevation");
    assert.equal(psArgumentList(["C:\\o'brien\\app"]), `'"C:\\o''brien\\app"'`);
});

// The third part of the same bug, and the one no test was watching. The
// arguments were built correctly and then pasted into a PowerShell command that
// spread Start-Process over three lines. A newline ends a statement here, so
// PowerShell read line two as a command called "-ArgumentList" and said so. The
// button raised no prompt at all.
test("the Start-Process call is a single statement", () => {
    const { buildElevateCommand } = require("../src/main/elevation");
    const command = buildElevateCommand({
        exe: "C:\\Program Files\\Panda Tweaks\\Panda Tweaks.exe",
        args: [APP, "--elevated"],
        workingDirectory: APP,
    });

    const startLine = command.split("\n").find((l) => l.includes("Start-Process"));
    assert.ok(startLine, "the command has to contain a Start-Process call");
    for (const param of ["-FilePath", "-ArgumentList", "-WorkingDirectory", "-Verb RunAs", "-PassThru"]) {
        assert.ok(startLine.includes(param), `${param} must sit on the Start-Process line, not on one of its own`);
    }
});

test("no line begins with a parameter", () => {
    const { buildElevateCommand } = require("../src/main/elevation");
    const command = buildElevateCommand({ exe: "C:\\x\\app.exe", args: ["--elevated"], workingDirectory: "C:\\x" });

    for (const line of command.split("\n")) {
        assert.ok(
            !line.trim().startsWith("-"),
            `PowerShell reads "${line.trim()}" as a command name, not as a parameter`
        );
    }
});

// A relaunch with no arguments must not leave a dangling -ArgumentList behind.
test("an empty argument list is left out entirely", () => {
    const { buildElevateCommand } = require("../src/main/elevation");
    const command = buildElevateCommand({ exe: "C:\\x\\app.exe", args: [], workingDirectory: "C:\\x" });

    assert.ok(!command.includes("-ArgumentList"), "Start-Process rejects -ArgumentList without a value");
});
