"use strict";

// Administrator detection and on-demand elevation.
//
// The app deliberately starts unelevated. Analysis, detection and every HKCU
// tweak work fine as a normal user; elevation is only requested when the user
// asks to apply something that genuinely needs it.

const path = require("path");
const { app } = require("electron");
const { execFileSync, execFile } = require("child_process");
const logger = require("./logger");

let cached = null;

function isAdmin() {
    if (cached !== null) return cached;
    try {
        // "net session" is refused for non-administrators — cheap and reliable.
        execFileSync("net.exe", ["session"], { stdio: "ignore", windowsHide: true });
        cached = true;
    } catch {
        cached = false;
    }
    return cached;
}

// Builds the relaunch arguments. Kept separate from the spawning so the part
// that is easy to get wrong can be tested without raising a UAC prompt.
//
// The trap here is relative paths. In development the app is started as
// `electron .`, so argv carries a bare ".". An elevated process does not
// inherit our working directory — Windows starts it in system32 — so that "."
// resolves somewhere else entirely and Electron comes up with no app to load.
// The process starts, and nothing appears. Every path is made absolute before
// it is handed over.
function buildRelaunch({ execPath, argv, appPath, packaged }) {
    const args = [];
    for (const arg of argv) {
        if (arg === "--elevated") continue;
        if (arg === "." || arg === "./") {
            args.push(appPath);
        } else if (!packaged && !path.isAbsolute(arg) && !arg.startsWith("-")) {
            args.push(path.resolve(appPath, arg));
        } else {
            args.push(arg);
        }
    }
    // A packaged build needs no app argument; a development run always does.
    if (!packaged && !args.some((a) => !a.startsWith("-"))) args.push(appPath);
    args.push("--elevated");

    return {
        exe: execPath,
        args,
        // Start the new instance where the app lives rather than wherever the
        // shell happened to be.
        workingDirectory: packaged ? path.dirname(execPath) : appPath,
    };
}

// For a PowerShell parameter that takes one value, such as -FilePath.
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// For -ArgumentList, which is a different problem.
//
// Start-Process joins the list with spaces and adds no quoting of its own, so
// an argument containing a space arrives at the child as several arguments.
// "C:\Users\...\panda tweaks free" became three, Electron looked for an app at
// "C:\Users\...\panda", and the relaunch opened an error window instead of the
// app. Each argument therefore carries double quotes for the child's command
// line, inside the single quotes PowerShell needs for its own parsing.
//
// Windows paths cannot contain a double quote, and these arguments are our own
// argv rather than anything a user or data file supplied.
const psArgumentList = (args) => args.map((a) => `'"${String(a).replace(/'/g, "''")}"'`).join(",");

// The PowerShell that raises the prompt. Separated from the spawning for the
// same reason buildRelaunch is: this is the part that broke, and a test must be
// able to look at it without a UAC dialog appearing.
//
// The whole Start-Process call has to stay on ONE line. A newline ends a
// statement in PowerShell, so a call spread over three lines was read as three
// commands, and the second of them was named "-ArgumentList". Windows answered
// with "-ArgumentList is not recognized as the name of a cmdlet" and the button
// did nothing. The indentation on those lines looked like a continuation and
// was not one - only a backtick or a pipe continues a line here.
function buildElevateCommand({ exe, args, workingDirectory }) {
    const start = [
        `$p = Start-Process -FilePath ${psQuote(exe)}`,
        args.length ? `-ArgumentList ${psArgumentList(args)}` : "",
        `-WorkingDirectory ${psQuote(workingDirectory)} -Verb RunAs -PassThru -ErrorAction Stop`,
    ]
        .filter(Boolean)
        .join(" ");

    return [
        // Without this the failure text comes back in the console codepage and
        // reaches the user as "ausf?hrbaren". The scripts under ps\ open the
        // same way.
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "try {",
        `  ${start}`,
        "  if ($null -eq $p) { exit 3 }",
        "  [Console]::Out.Write($p.Id)",
        "} catch {",
        "  [Console]::Error.Write($_.Exception.Message)",
        "  exit 2",
        "}",
    ].join("\n");
}

// Relaunches this app through the UAC prompt.
//
// The old version fired the relaunch and quit after a fixed delay, which meant
// that declining the UAC prompt — or any failure to start — closed the running
// app and looked exactly like a button that does nothing. Now the result is
// awaited: the current instance only quits once Windows has handed back a
// process id for the elevated one.
async function elevate() {
    if (isAdmin()) return { ok: true, alreadyElevated: true };

    const { exe, args, workingDirectory } = buildRelaunch({
        execPath: process.execPath,
        argv: process.argv.slice(1),
        appPath: app.getAppPath(),
        packaged: app.isPackaged,
    });

    const command = buildElevateCommand({ exe, args, workingDirectory });

    const result = await new Promise((resolve) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-Command", command],
            // The prompt sits on the secure desktop until the user answers it,
            // so this wait is as long as a person takes to read a dialog.
            { windowsHide: true, timeout: 180_000 },
            (err, stdout, stderr) => resolve({ err, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() })
        );
    });

    const pid = Number.parseInt(result.stdout, 10);
    if (result.err || !Number.isFinite(pid) || pid <= 0) {
        const message = result.stderr || result.err?.message || "The elevated instance did not start";
        // Windows says this in whatever language it is running in, so the check
        // is on the shape of the interaction, not on the wording.
        const cancelled = /canceled|cancelled|abgebrochen|1223/i.test(message);
        logger.warn(cancelled ? "Elevation declined by the user" : "Elevation failed", { error: message });
        return { ok: false, cancelled, error: message };
    }

    logger.info("Relaunching elevated at user request", { pid });
    // The elevated instance exists; this one can go.
    setTimeout(() => app.quit(), 400);
    return { ok: true, relaunching: true, pid };
}

module.exports = { isAdmin, elevate, buildRelaunch, psArgumentList, buildElevateCommand };
