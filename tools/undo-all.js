"use strict";

// Undoes every change Panda Tweaks still has a snapshot for, newest first.
//
// The app can only undo one history entry at a time, which is fine for undoing
// a mistake and useless for "put everything back". This walks the whole history
// through engine.undoEntry() - the same function the undo button calls, so the
// snapshot handling, the logging and the history bookkeeping are not
// reimplemented here and cannot drift from it.
//
// Newest first matters. A tweak applied five times has five snapshots; undoing
// them in reverse order ends on the value that was there before the first run.
//
//   node tools/undo-all.js            show what would happen, change nothing
//   node tools/undo-all.js --run      actually undo
//   node tools/undo-all.js --run --apps   also reinstall the removed Store apps
//
// Anything this cannot undo it names instead of quietly skipping. What another
// tweaking tool changed was never captured here, so it is not in this list and
// cannot be restored from it - a Windows restore point is the only thing that
// covers that.

const os = require("os");
const path = require("path");

const APP_DIR = path.join(process.env.APPDATA || os.homedir(), "Panda Tweaks");
const DATA_DIR = path.join(__dirname, "..", "src", "data");

const args = process.argv.slice(2);
const RUN = args.includes("--run");
const APPS = args.includes("--apps");

const { execFileSync } = require("child_process");
const logger = require("../src/main/logger");
const engine = require("../src/main/engine");

// The same check elevation.js makes. Not imported from there because that module
// pulls in electron, which this script does not otherwise need.
function isAdmin() {
    try {
        execFileSync("net.exe", ["session"], { stdio: "ignore", windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

function appIsRunning() {
    try {
        const out = execFileSync("tasklist.exe", ["/fi", "imagename eq Panda Tweaks.exe", "/nh"], {
            windowsHide: true,
        }).toString();
        return /Panda Tweaks\.exe/i.test(out);
    } catch {
        return false; // tasklist unavailable: not a reason to refuse
    }
}

// What the undo will put back. record.describe is the description of the change
// going the other way ("set service X to disabled"), so showing that in a
// preview of an undo says the opposite of what will happen.
function restoreTarget(record) {
    const p = record.previous;
    if (!record.undoable) return "nicht umkehrbar";
    if (!p || p.readFailed) return "SNAPSHOT FEHLT - wird uebersprungen";
    if (p.exists === false) return "existierte vorher nicht -> wird geloescht";
    if (p.startMode) return `Dienst zurueck auf "${p.startMode}"`;
    if (p.value !== undefined) return `zurueck auf ${JSON.stringify(p.value)}`;
    if (p.enabled !== undefined) return `zurueck auf ${p.enabled ? "an" : "aus"}`;
    if (p.ac !== undefined) return `zurueck auf ${p.ac}`;
    return JSON.stringify(p).slice(0, 50);
}

async function main() {
    logger.init(APP_DIR);
    engine.loadTweaks(DATA_DIR);
    engine.initBlocked(APP_DIR);
    engine.initHistory(APP_DIR);

    // The app keeps the history in memory and writes the whole file on every
    // change. If it is open while this runs, its copy wins on the next write and
    // the snapshots this just consumed are back - or worse, lost.
    if (appIsRunning()) {
        console.error("Panda Tweaks laeuft gerade. Erst schliessen - sonst ueberschreibt die App die Historie.");
        process.exitCode = 1;
        return;
    }

    const admin = isAdmin();
    // getHistory() already hands them back newest first, which is the order the
    // undo has to run in.
    const all = engine.getHistory();
    const entries = all.filter((e) => e.undoable && e.status !== "undone");

    const apps = entries.filter((e) => String(e.tweakId).startsWith("appx:"));
    const settings = entries.filter((e) => !String(e.tweakId).startsWith("appx:"));
    const todo = APPS ? entries : settings;

    console.log(`Historie: ${all.length} Eintraege, ${entries.length} noch rueckgaengig machbar`);
    console.log(`  ${settings.length} Einstellungen`);
    console.log(`  ${apps.length} entfernte Store-Apps  ${APPS ? "(werden mit zurueckgeholt)" : "(uebersprungen, --apps holt sie zurueck)"}`);
    console.log(`Administrator: ${admin ? "ja" : "NEIN - alles unter HKLM und jeder Dienst wird sich weigern"}`);
    console.log();

    if (!RUN) {
        console.log("Probelauf - es wird nichts geaendert. Mit --run ausfuehren.\n");
        for (const e of todo) {
            console.log(`  ${String(e.tweakId).padEnd(30)} ${(e.ops || []).map(restoreTarget).join(" | ").slice(0, 110)}`);
        }
        return;
    }

    let ok = 0;
    let partial = 0;
    let failed = 0;
    let restart = false;
    const problems = [];

    for (const e of todo) {
        const res = await engine.undoEntry(e.id, { isAdmin: admin });
        if (res.requiresRestart) restart = true;
        if (res.ok) {
            ok++;
        } else if (res.restored > 0) {
            partial++;
            problems.push(`${e.tweakId}: ${res.restored} zurueck, ${res.failed} nicht`);
        } else {
            failed++;
            problems.push(`${e.tweakId}: ${res.error || res.status}`);
        }
    }

    console.log(`\nfertig: ${ok} zurueckgenommen, ${partial} teilweise, ${failed} fehlgeschlagen`);
    if (problems.length) {
        console.log("\nnicht (ganz) zurueckgenommen:");
        for (const p of problems) console.log("  " + p);
    }
    if (restart) console.log("\nEin Neustart macht alle Aenderungen wirksam.");
}

main().catch((e) => {
    console.error("Abgebrochen:", e.message);
    process.exitCode = 1;
});
