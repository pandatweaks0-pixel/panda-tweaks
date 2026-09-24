"use strict";

// Tweak engine: detection, application and undo.
//
// The undo model is the important part. Applying a tweak captures the real
// current state of every value it touches and stores that snapshot in the
// history file. Undo replays the snapshot. Nothing is reverted to an assumed
// Windows default, so a user who had MenuShowDelay at 200 gets 200 back, not
// the 400 that a hardcoded revert command would have written.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getOp, validateOp, listInstalledApps, listStartupEntries, runningBlockers } = require("./ops");
const logger = require("./logger");

const RISK_LEVELS = new Set(["safe", "advanced", "risky"]);

let tweaks = [];
let tweakById = new Map();
let historyPath = null;
let history = { version: 1, entries: [] };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function normalizeTweak(raw) {
    const problems = [];
    const ops = [];
    for (const rawOp of raw.operations || []) {
        try {
            ops.push(validateOp(rawOp));
        } catch (e) {
            problems.push(e.message);
        }
    }
    if (!ops.length && !problems.length) problems.push("Tweak defines no operations");

    const risk = RISK_LEVELS.has(raw.risk) ? raw.risk : "advanced";
    return {
        id: String(raw.id),
        name: String(raw.name || raw.id),
        category: String(raw.category || "Windows"),
        risk,
        description: String(raw.description || ""),
        detailedDescription: String(raw.detailedDescription || raw.description || ""),
        // Risky tweaks are never recommended by default — the user has to opt in.
        recommended: risk === "risky" ? false : raw.recommended === true,
        requiresRestart: raw.requiresRestart === true,
        requiresAdmin: ops.some((op) => getOp(op.type).requiresAdmin(op)),
        undoable: ops.length > 0 && ops.every((op) => getOp(op.type).undoable),
        warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
        // What Windows ships by default, purely informational for the details
        // dialog. Undo does NOT use this — it uses the captured snapshot.
        windowsDefault: raw.windowsDefault || null,
        minBuild: typeof raw.minBuild === "number" ? raw.minBuild : null,
        maxBuild: typeof raw.maxBuild === "number" ? raw.maxBuild : null,
        operations: ops,
        // A tweak whose definition is broken stays visible but cannot be run,
        // rather than silently disappearing.
        unavailable: problems.length ? problems.join("; ") : null,
        affected: ops.map((op) => getOp(op.type).describe(op)),
    };
}

// A curated service and a disk cleanup target are both just a tweak with one
// operation. Expressing them that way means detection, application, undo,
// history and the "what this changes" dialog all work with no extra code — the
// alternative was a second, parallel pipeline for each.
function serviceTweaks(dataDir) {
    let list;
    try {
        list = JSON.parse(fs.readFileSync(path.join(dataDir, "services.json"), "utf8"));
    } catch (e) {
        logger.warn("Could not load service catalogue", { error: e.message });
        return [];
    }
    return (Array.isArray(list) ? list : []).map((svc) => ({
        id: `service_${String(svc.name).toLowerCase()}`,
        name: svc.label || svc.name,
        category: "Services",
        risk: svc.risk || "advanced",
        description: svc.description || "",
        detailedDescription: svc.description || "",
        recommended: svc.recommended === true,
        // Disabling a service takes effect immediately; undo restores the start
        // type that was captured, not an assumed default.
        operations: [{ type: "service", name: svc.name, startMode: "disabled", stop: true }],
    }));
}

// Repairs are the mirror image of a tweak: they put defaults back rather than
// change them away. Same shape, same pipeline — they are never recommended and
// never pre-selected, because running a repair you did not need is pointless
// work, not an improvement.
function fixTweaks(dataDir) {
    let list;
    try {
        list = JSON.parse(fs.readFileSync(path.join(dataDir, "fixes.json"), "utf8"));
    } catch (e) {
        logger.warn("Could not load repair catalogue", { error: e.message });
        return [];
    }
    return (Array.isArray(list) ? list : []).map((fix) => ({
        ...fix,
        category: "Fixes",
        risk: fix.risk || "safe",
        recommended: false,
        detailedDescription: fix.detailedDescription || fix.description,
    }));
}

const CLEANUP_TARGETS = [
    { target: "userTemp", name: "Your Temp Folder", description: "Files programs left behind in your temp folder." },
    { target: "windowsTemp", name: "Windows Temp Folder", description: "The system-wide temp folder." },
    { target: "prefetch", name: "Prefetch Data", description: "Windows rebuilds these; the first start of each app is slower afterwards." },
    { target: "windowsUpdateCache", name: "Windows Update Cache", description: "Installer files for updates that are already installed." },
    { target: "crashDumps", name: "Crash Dumps", description: "Memory dumps written when an application crashed." },
    { target: "thumbnailCache", name: "Thumbnail Cache", description: "Explorer rebuilds thumbnails on demand." },
];

const cleanupTweaks = () =>
    CLEANUP_TARGETS.map((c) => ({
        id: `cleanup_${c.target}`,
        name: c.name,
        category: "Cleanup",
        risk: "safe",
        description: c.description,
        detailedDescription: c.description,
        // Deleting files is not undoable, so it is never pre-selected.
        recommended: false,
        operations: [{ type: "cleanup", target: c.target }],
    }));

function loadTweaks(dataDir) {
    const file = path.join(dataDir, "tweaks.json");
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        logger.error("Could not load tweak database", { file, error: e.message });
        tweaks = [];
        tweakById = new Map();
        return { ok: false, error: e.message, count: 0 };
    }
    const list = [
        ...(Array.isArray(raw) ? raw : raw.tweaks || []),
        ...serviceTweaks(dataDir),
        ...cleanupTweaks(),
        ...fixTweaks(dataDir),
    ];
    tweaks = list.map(normalizeTweak);
    tweakById = new Map(tweaks.map((t) => [t.id, t]));

    const broken = tweaks.filter((t) => t.unavailable);
    if (broken.length) {
        logger.warn("Tweaks with invalid definitions", {
            count: broken.length,
            ids: broken.map((t) => t.id),
        });
    }
    logger.info("Tweak database loaded", { total: tweaks.length, unavailable: broken.length });
    return { ok: true, count: tweaks.length, unavailable: broken.length };
}

const getTweaks = () => tweaks;
const getTweak = (id) => tweakById.get(id) || null;

// ---------------------------------------------------------------------------
// Tweaks this machine refuses
// ---------------------------------------------------------------------------

// Some tweaks cannot work on a given build, and nothing readable says so in
// advance: Windows protects the value, the write is denied, and the next scan
// still reports "not applied" — so the tweak is recommended again, fails again,
// and looks like a broken app rather than a closed door.
//
// The first refusal is therefore remembered. From then on the tweak is shown as
// unavailable with the reason, exactly like one whose definition cannot be
// validated. Deleting blocked.json makes the app try again.
let blockedPath = null;
let blocked = {};

function initBlocked(userDataDir) {
    blockedPath = path.join(userDataDir, "blocked.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(blockedPath, "utf8"));
        blocked = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        blocked = {};
    }
    applyBlocked();
}

function applyBlocked() {
    for (const tweak of tweaks) {
        const reason = blocked[tweak.id];
        if (reason && !tweak.unavailable) tweak.unavailable = reason;
    }
}

function markBlocked(id, reason) {
    if (blocked[id]) return;
    blocked[id] = reason;
    logger.warn("Tweak marked unavailable on this machine", { tweak: id, reason });
    try {
        if (blockedPath) fs.writeFileSync(blockedPath, JSON.stringify(blocked, null, 2), "utf8");
    } catch (e) {
        logger.error("Could not record the blocked tweak", { error: e.message });
    }
    applyBlocked();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Groups every operation of every tweak by type so each type is read in one
// batch, instead of one process spawn per value.
async function captureFor(tweakList) {
    const byType = new Map();
    for (const t of tweakList) {
        for (const op of t.operations) {
            if (!byType.has(op.type)) byType.set(op.type, []);
            byType.get(op.type).push(op);
        }
    }
    const captured = new Map();
    for (const [type, ops] of byType) {
        try {
            const result = await getOp(type).capture(ops);
            for (const [op, state] of result) captured.set(op, state);
        } catch (e) {
            logger.error("Capture failed for operation type", { type, error: e.message });
            for (const op of ops) captured.set(op, { readFailed: true, error: e.message });
        }
    }
    return captured;
}

function statusFromOps(tweak, captured) {
    if (tweak.unavailable) return { status: "unavailable", detail: tweak.unavailable };
    let applied = 0;
    let unknown = 0;
    for (const op of tweak.operations) {
        const verdict = getOp(op.type).isApplied(op, captured.get(op));
        if (verdict === null) unknown++;
        else if (verdict) applied++;
    }
    const total = tweak.operations.length;
    if (unknown === total) return { status: "unknown", detail: null };
    if (applied === total) return { status: "applied", detail: null };
    if (applied === 0) return { status: "not-applied", detail: null };
    return { status: "partial", detail: `${applied}/${total} operations in place` };
}

// Reading a tweak's state costs something — for cleanup targets it is a full
// directory walk with no answer at the end of it. Those types declare
// detectable: false and a blanket scan skips them; asking for their ids
// explicitly (the cleanup page does) still runs the scan and reports real sizes.
const alwaysUnknown = (t) => t.operations.length > 0 && t.operations.every((op) => getOp(op.type).detectable === false);

async function detect(ids = null, systemBuild = null) {
    const list = ids ? ids.map(getTweak).filter(Boolean) : tweaks.filter((t) => !alwaysUnknown(t));
    const captured = await captureFor(list);
    return list.map((t) => {
        const supported =
            (t.minBuild === null || systemBuild === null || systemBuild >= t.minBuild) &&
            (t.maxBuild === null || systemBuild === null || systemBuild <= t.maxBuild);
        return {
            id: t.id,
            ...statusFromOps(t, captured),
            supported,
        };
    });
}

// Reads the live state of one tweak's operations so the details dialog can show
// "what it is on this machine" next to "what it would become". Nothing is
// written; this is the same capture the apply path uses.
async function inspect(id) {
    const tweak = getTweak(id);
    if (!tweak) return null;
    const captured = await captureFor([tweak]);
    return {
        id: tweak.id,
        ...statusFromOps(tweak, captured),
        operations: tweak.operations.map((op) => {
            const handler = getOp(op.type);
            const current = captured.get(op);
            return {
                describe: handler.describe(op),
                applied: handler.isApplied(op, current),
                ...handler.explain(op, current),
            };
        }),
    };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function initHistory(userDataDir) {
    historyPath = path.join(userDataDir, "history.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
        if (parsed && Array.isArray(parsed.entries)) history = parsed;
    } catch {
        history = { version: 1, entries: [] }; // first run, or unreadable file
    }
}

function saveHistory() {
    if (!historyPath) return;
    try {
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf8");
    } catch (e) {
        logger.error("Could not write history", { error: e.message });
    }
}

const getHistory = () => history.entries.slice().reverse(); // newest first

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

// Which operations count as evidence when reading a result back.
//
// Running sfc, flushing DNS or deleting a temp folder answers nothing when you
// read it back — that is what detectable: false means. Judging a result by them
// marked every repair "unverified" even when every single step had succeeded:
// the same mistake as treating a failed read as a failure. A verdict nobody can
// give is not a bad verdict.
const verifiableOps = (tweak) => tweak.operations.filter((op) => getOp(op.type).detectable !== false);

async function applyOne(tweak, { isAdmin }) {
    if (tweak.unavailable) {
        return { tweakId: tweak.id, status: "failed", error: tweak.unavailable, entryId: null };
    }
    if (tweak.requiresAdmin && !isAdmin) {
        // Logged, because this refusal happens before any operation runs and so
        // before anything else here writes a line. A run that failed five of
        // seven tweaks for this reason left a log with nothing in it at all,
        // which made it look like the failures had no cause.
        logger.warn("Tweak refused: needs administrator rights", { tweak: tweak.id });
        return {
            tweakId: tweak.id,
            status: "failed",
            error: "needs-admin",
            entryId: null,
        };
    }

    // Snapshot immediately before writing, so the captured state is the state
    // this apply is actually replacing.
    const captured = await captureFor([tweak]);

    const entry = {
        id: crypto.randomUUID(),
        tweakId: tweak.id,
        tweakName: tweak.name,
        risk: tweak.risk,
        appliedAt: new Date().toISOString(),
        status: "applying",
        undoneAt: null,
        requiresRestart: tweak.requiresRestart,
        undoable: tweak.undoable,
        ops: [],
    };

    let succeeded = 0;
    for (const op of tweak.operations) {
        const handler = getOp(op.type);
        const previous = captured.get(op) || null;
        let result;
        try {
            // The captured state goes in as well: a handler sometimes has to know
            // what it is replacing to tell "already the way you want it" and
            // "not present at all" apart from a real failure.
            result = await handler.apply(op, previous);
        } catch (e) {
            result = { ok: false, error: e.message };
        }
        if (result.ok) succeeded++;
        entry.ops.push({
            op,
            describe: handler.describe(op),
            previous,
            undoable: handler.undoable && !!previous && !previous.readFailed,
            result: { ok: !!result.ok, error: result.error || null, warning: result.warning || null, detail: result.detail || null },
        });
        logger.info(result.ok ? "Operation applied" : "Operation failed", {
            tweak: tweak.id,
            op: handler.describe(op),
            previous,
            error: result.error || undefined,
        });
    }

    const total = tweak.operations.length;
    entry.status = succeeded === total ? "applied" : succeeded === 0 ? "failed" : "partial";

    // A refusal Windows will repeat forever is worth remembering, so the tweak
    // stops being offered instead of failing on every batch.
    if (succeeded === 0) {
        const permanent = entry.ops.find((o) => !o.result.ok && /protects this value/i.test(o.result.error || ""));
        if (permanent) markBlocked(tweak.id, permanent.result.error);
    }

    // Read the values back: a write that reported success but did not stick is
    // reported as unverified rather than as a success.
    if (succeeded > 0) {
        const verifiable = verifiableOps(tweak);
        if (!verifiable.length) {
            // Nothing to check against: null, distinct from "checked and wrong".
            entry.verified = null;
        } else {
            const after = await captureFor([tweak]);
            const check = statusFromOps({ ...tweak, operations: verifiable }, after);
            // "unknown" means nothing could be read back, which is the same
            // situation as having nothing to check against - null, not false.
            // Calling it false flagged a flushed DNS cache and a restarted
            // Explorer as unverified: both did exactly what was asked, and
            // neither leaves a value behind to prove it.
            entry.verified = check.status === "unknown" ? null : check.status === "applied";
            if (entry.status === "applied" && entry.verified === false) {
                entry.status = "unverified";
            }
        }
    } else {
        entry.verified = false;
    }

    history.entries.push(entry);
    saveHistory();

    return {
        tweakId: tweak.id,
        status: entry.status,
        verified: entry.verified,
        entryId: entry.id,
        error: entry.ops.find((o) => !o.result.ok)?.result.error || null,
    };
}

// Applies a list of tweaks one after another. A single failure never aborts the
// batch and never throws out of here.
// Programs that have to be closed before this selection can be applied, and
// that are open right now. Asked before anything is written, so the caller can
// stop rather than apply most of a batch and fail the part that mattered.
function blockersFor(ids) {
    const ops = [];
    for (const id of ids || []) {
        const tweak = getTweak(id);
        if (!tweak || tweak.unavailable) continue;
        for (const op of tweak.operations || []) ops.push(op);
    }
    return runningBlockers(ops);
}

async function applyTweaks(ids, { isAdmin = false, onProgress = null } = {}) {
    const list = ids.map(getTweak).filter(Boolean);
    const results = [];
    for (let i = 0; i < list.length; i++) {
        const tweak = list[i];
        if (onProgress) onProgress({ index: i, total: list.length, tweakId: tweak.id, name: tweak.name });
        let res;
        try {
            res = await applyOne(tweak, { isAdmin });
        } catch (e) {
            logger.error("Unexpected error applying tweak", { tweak: tweak.id, error: e.message });
            res = { tweakId: tweak.id, status: "failed", error: e.message, entryId: null };
        }
        results.push(res);
    }
    return {
        results,
        summary: {
            total: results.length,
            applied: results.filter((r) => r.status === "applied").length,
            partial: results.filter((r) => r.status === "partial" || r.status === "unverified").length,
            failed: results.filter((r) => r.status === "failed").length,
            restartRequired: results.some(
                (r) => r.status !== "failed" && getTweak(r.tweakId)?.requiresRestart
            ),
        },
    };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

async function undoEntry(entryId, { isAdmin = false } = {}) {
    const entry = history.entries.find((e) => e.id === entryId);
    if (!entry) return { ok: false, error: "History entry not found" };
    if (entry.status === "undone") return { ok: false, error: "This change was already undone" };

    const tweak = getTweak(entry.tweakId);
    if (tweak && tweak.requiresAdmin && !isAdmin) {
        return { ok: false, error: "needs-admin" };
    }

    let restored = 0;
    let failed = 0;
    // Reverse order: if a tweak created a key and then set a value inside it,
    // the value is removed before the key.
    for (const record of [...entry.ops].reverse()) {
        if (!record.undoable) {
            failed++;
            record.undoResult = { ok: false, error: "This operation cannot be undone" };
            continue;
        }
        let res;
        try {
            res = await getOp(record.op.type).restore(record.op, record.previous);
        } catch (e) {
            res = { ok: false, error: e.message };
        }
        record.undoResult = { ok: !!res.ok, error: res.error || null };
        if (res.ok) restored++;
        else failed++;
        logger.info(res.ok ? "Operation undone" : "Undo failed", {
            tweak: entry.tweakId,
            op: record.describe,
            restoredTo: record.previous,
            error: res.error || undefined,
        });
    }

    entry.status = failed === 0 ? "undone" : restored === 0 ? "undo-failed" : "undo-partial";
    entry.undoneAt = new Date().toISOString();
    saveHistory();

    return {
        ok: failed === 0,
        status: entry.status,
        restored,
        failed,
        requiresRestart: entry.requiresRestart,
    };
}

// ---------------------------------------------------------------------------
// Debloat (Store app removal)
// ---------------------------------------------------------------------------

// Store apps are not tweaks — there is no reversible previous state to snapshot.
// They still go through the history so the user has a record of exactly what was
// removed and when, which is the most the app can honestly offer here.
// A package name is not a product name. "MicrosoftCorporationII.QuickAssist"
// becomes "Quick Assist": drop the publisher segment when it is recognisably a
// publisher, then split the CamelCase. Only ever a label — every view also shows
// the exact package name, because that is what actually gets removed.
const PUBLISHER_SEGMENT = /^(microsoft[a-z]*(ii)?|windows|\d.*|[a-z]*corp[a-z]*|[a-z]*ab|[a-z]*inc)$/i;

function friendlyAppName(pkg) {
    const parts = String(pkg).split(".");
    if (parts.length > 1 && PUBLISHER_SEGMENT.test(parts[0])) parts.shift();
    return (
        parts
            .join(" ")
            // Acronym boundary first (NVIDIAControl -> NVIDIA Control), then the
            // ordinary CamelCase one, or the acronym gets shredded letter by letter.
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/\s+/g, " ")
            .trim() || String(pkg)
    );
}

const publisherName = (raw) => (String(raw || "").match(/CN=([^,]+)/) || [])[1] || "";

// Windows ships three very different things through the same Appx mechanism,
// and a flat list of all of them is unusable: the codec that makes videos play
// sits next to the news app nobody opened. Sorting them apart is a heuristic on
// the package name and publisher — deliberately conservative, because the cost
// of mislabelling a runtime as "preinstalled app" is a user removing it.
//
// ponytail: name-based classification, no manifest reads. If it starts
// mislabelling, read Package.Properties.DisplayName per package instead.
const COMPONENT_RE =
    /(VideoExtension|VideoExtensions|ImageExtension|MediaExtension|WebMediaExtensions|VCLibs|NET\.Native|UI\.Xaml|WinAppRuntime|WindowsAppRuntime|LanguageExperiencePack|Ink\.Handwriting|DesktopAppInstaller|StorePurchaseApp|WindowsStore|XboxIdentityProvider|GamingServices|SecHealthUI|WebExperience|CrossDevice|ApplicationCompatibility|WidgetsPlatformRuntime|Client\.WebExperience|\.Main\.)/i;

const DEBLOAT_GROUPS = ["recommended", "preinstalled", "thirdparty", "components", "absent"];

function classifyApp({ package: pkg, publisher, isProtected, recommended, installed }) {
    if (!installed) return "absent";
    if (recommended) return "recommended";
    if (isProtected || COMPONENT_RE.test(pkg)) return "components";
    // Publisher is the only reliable Microsoft/third-party signal available
    // without opening each package manifest.
    return /microsoft/i.test(publisher || "") || /^Microsoft/i.test(pkg) ? "preinstalled" : "thirdparty";
}

// Merges what the catalogue knows with what is actually on this machine.
//
// The catalogue used to *be* the list, which meant a machine without those exact
// Windows-10-era packages was offered nothing at all while its real preinstalled
// apps stayed invisible. The system is the source of truth now; the catalogue
// only contributes names, descriptions and the recommendation.
//
// Catalogue entries that match nothing are still returned (installed: false) so
// the list never silently drops something the data file promised.
function mergeDebloatCatalogue(catalogue, installed) {
    const entries = [];
    const claimed = new Set();

    for (const app of installed) {
        // Exact match first. Catalogue entries are matched as substrings so a
        // fragment like "BingNews" finds "Microsoft.BingNews", but that also lets
        // a short entry shadow a longer, more specific one.
        const pkg = app.package.toLowerCase();
        const hit =
            catalogue.find((c) => pkg === String(c.package).toLowerCase()) ||
            catalogue.find((c) => pkg.includes(String(c.package).toLowerCase()));
        if (hit) claimed.add(hit.package);
        const entry = {
            id: hit ? hit.id : `app_${app.package.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
            package: app.package,
            resolved: [app.package],
            name: hit ? hit.name : friendlyAppName(app.package),
            description: hit ? hit.description : "",
            // An app the catalogue never described is never recommended and never
            // pre-selected: the app has no basis for saying it is safe to lose.
            recommended: hit ? !!hit.recommended : false,
            risk: hit ? hit.risk || "safe" : "advanced",
            // Removable, but you almost certainly want it. Not a block — the
            // blocklist in ops.js is for things that break Windows — a label,
            // so the row and the confirmation say what is about to be lost.
            keep: hit ? hit.keep === true : false,
            known: !!hit,
            installed: true,
            protected: !!app.protected,
            publisher: app.publisher || "",
            version: app.version || "",
        };
        entry.group = classifyApp({ ...entry, isProtected: entry.protected });
        entries.push(entry);
    }

    for (const c of catalogue) {
        if (claimed.has(c.package)) continue;
        entries.push({
            ...c,
            keep: c.keep === true,
            resolved: [],
            known: true,
            installed: false,
            protected: false,
            publisher: "",
            version: "",
            group: "absent",
        });
    }

    // Actionable first, machinery last.
    const rank = (e) => DEBLOAT_GROUPS.indexOf(e.group);
    return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function listApps(catalogue) {
    const res = await listInstalledApps();
    if (!res.ok) return { ok: false, error: res.error, entries: mergeDebloatCatalogue(catalogue, []) };
    const installed = res.apps.map((a) => ({ ...a, publisher: publisherName(a.publisher) }));
    return { ok: true, error: null, entries: mergeDebloatCatalogue(catalogue, installed) };
}

async function removeApps(packages, { onProgress = null } = {}) {
    const results = [];
    for (let i = 0; i < packages.length; i++) {
        const name = packages[i];
        if (onProgress) onProgress({ index: i, total: packages.length, tweakId: name, name });

        let op;
        try {
            op = validateOp({ type: "appx", package: name });
        } catch (e) {
            results.push({ package: name, ok: false, error: e.message });
            continue;
        }

        const handler = getOp("appx");
        const captured = await handler.capture([op]);
        const previous = captured.get(op) || null;

        let result;
        try {
            result = await handler.apply(op);
        } catch (e) {
            result = { ok: false, error: e.message };
        }

        const entry = {
            id: crypto.randomUUID(),
            tweakId: `appx:${name}`,
            tweakName: name,
            risk: "safe",
            kind: "debloat",
            appliedAt: new Date().toISOString(),
            status: result.ok ? "applied" : "failed",
            verified: !!result.ok,
            undoneAt: null,
            requiresRestart: false,
            // The handler still declares appx removal as not undoable, because
            // success cannot be promised: the files may be gone and reading them
            // needs elevation. The history entry offers the attempt anyway —
            // most per-user removals can be registered again straight from disk,
            // and a real attempt with an honest failure beats a greyed-out
            // button that never lets you find out.
            undoable: true,
            ops: [
                {
                    op,
                    describe: handler.describe(op),
                    previous,
                    undoable: true,
                    result: { ok: !!result.ok, error: result.error || null, warning: null, detail: result.detail || null },
                },
            ],
        };
        history.entries.push(entry);
        logger.info(result.ok ? "Store app removed" : "Store app removal failed", {
            package: name,
            error: result.error || undefined,
        });

        results.push({ package: name, ok: !!result.ok, error: result.error || null, entryId: entry.id });
    }
    saveHistory();
    return {
        results,
        summary: {
            total: results.length,
            removed: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
        },
    };
}

// ---------------------------------------------------------------------------
// Autostart
// ---------------------------------------------------------------------------

// Autostart entries are per-machine facts, not catalogue entries, so they are
// listed rather than defined. Toggling one still goes through a history entry
// with the captured previous state, which is what makes the Undo on the history
// page work for them exactly as it does for a tweak.
async function listStartup() {
    const res = await listStartupEntries();
    return { ok: res.ok, error: res.error, entries: res.entries };
}

async function setStartup(changes, { onProgress = null } = {}) {
    const results = [];
    const handler = getOp("startup");

    for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        if (onProgress) onProgress({ index: i, total: changes.length, tweakId: change.name, name: change.name });

        let op;
        try {
            op = validateOp({ type: "startup", name: change.name, scope: change.scope, enabled: change.enabled === true });
        } catch (e) {
            results.push({ name: change.name, ok: false, error: e.message });
            continue;
        }

        const previous = (await handler.capture([op])).get(op) || null;

        let result;
        try {
            result = await handler.apply(op);
        } catch (e) {
            result = { ok: false, error: e.message };
        }

        const entry = {
            id: crypto.randomUUID(),
            tweakId: `startup:${op.scope}:${op.name}`,
            tweakName: op.name,
            risk: "safe",
            kind: "startup",
            appliedAt: new Date().toISOString(),
            status: result.ok ? "applied" : "failed",
            verified: !!result.ok,
            undoneAt: null,
            requiresRestart: false,
            undoable: true,
            ops: [
                {
                    op,
                    describe: handler.describe(op),
                    previous,
                    undoable: true,
                    result: { ok: !!result.ok, error: result.error || null, warning: null, detail: null },
                },
            ],
        };
        history.entries.push(entry);
        logger.info(result.ok ? "Autostart entry changed" : "Autostart change failed", {
            entry: op.name,
            scope: op.scope,
            to: op.enabled ? "enabled" : "disabled",
            was: previous && previous.exists ? (previous.enabled ? "enabled" : "disabled") : "unknown",
            error: result.error || undefined,
        });

        results.push({ name: op.name, ok: !!result.ok, error: result.error || null, entryId: entry.id });
    }
    saveHistory();
    return {
        results,
        summary: {
            total: results.length,
            changed: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
        },
    };
}

module.exports = {
    listApps,
    listStartup,
    setStartup,
    mergeDebloatCatalogue,
    DEBLOAT_GROUPS,
    classifyApp,
    friendlyAppName,
    removeApps,
    inspect,
    loadTweaks,
    getTweaks,
    getTweak,
    detect,
    initHistory,
    initBlocked,
    getHistory,
    applyTweaks,
    blockersFor,
    undoEntry,
    normalizeTweak,
    statusFromOps,
    verifiableOps,
    captureFor,
};
