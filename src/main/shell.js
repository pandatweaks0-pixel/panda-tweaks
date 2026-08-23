"use strict";

// Process helpers. Everything goes through execFile with an argument array —
// never a shell string — so nothing in a tweak definition can be interpreted
// as a command separator.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TIMEOUT = 60_000;

function run(file, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            {
                windowsHide: true,
                maxBuffer: 8 * 1024 * 1024,
                timeout: opts.timeout || DEFAULT_TIMEOUT,
                env: opts.env ? { ...process.env, ...opts.env } : process.env,
            },
            (err, stdout, stderr) => {
                resolve({
                    ok: !err,
                    // execFile reports the exit code on err.code for a non-zero exit,
                    // but a string like "ETIMEDOUT" when the process never finished.
                    code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
                    stdout: String(stdout || "").trim(),
                    stderr: String(stderr || "").trim(),
                    error: err ? err.message : null,
                });
            }
        );
    });
}

// In a packaged build the app lives inside an asar archive. Electron patches
// its own fs so JSON data files still read fine, but PowerShell is a separate
// process with no idea what an asar is: `-File ...\app.asar\...\appx.ps1` fails
// with "the argument does not exist", and every read in the app dies with it.
//
// electron-builder therefore unpacks src/main/ps (see asarUnpack in
// package.json) and the real file sits in the .unpacked twin of that path.
// Rewriting it here fixes every caller at once, and does nothing in a dev run
// where no asar exists.
const ASAR = `app.asar${path.sep}`;
const resolveScript = (p) => (p.includes(ASAR) ? p.replace(ASAR, `app.asar.unpacked${path.sep}`) : p);

// Runs a fixed PowerShell script file. Data never reaches the script as source
// text: it is written to a temp JSON file whose path is handed over through an
// environment variable, so a value containing quotes or semicolons is inert.
async function runPsScript(scriptPath, input) {
    let inputPath = null;
    try {
        const env = {};
        if (input !== undefined) {
            inputPath = path.join(
                os.tmpdir(),
                `panda-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
            );
            fs.writeFileSync(inputPath, JSON.stringify(input), "utf8");
            env.PANDA_INPUT = inputPath;
        }
        const res = await run(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolveScript(scriptPath)],
            { env, timeout: 120_000 }
        );
        return res;
    } finally {
        if (inputPath) {
            try {
                fs.unlinkSync(inputPath);
            } catch {
                /* temp file already gone */
            }
        }
    }
}

async function runPsJson(scriptPath, input, fallback = null) {
    const res = await runPsScript(scriptPath, input);
    if (!res.ok || !res.stdout) return { ok: false, data: fallback, error: res.error || res.stderr };
    try {
        return { ok: true, data: JSON.parse(res.stdout), error: null };
    } catch (e) {
        return { ok: false, data: fallback, error: `Unparsable output: ${e.message}` };
    }
}

module.exports = { run, runPsScript, runPsJson };
