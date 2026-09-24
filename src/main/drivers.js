"use strict";

// Superseded driver packages in the driver store.
//
// Every driver update leaves the previous package behind in
// System32\DriverStore\FileRepository - a graphics driver is 1-2 GB each time.
// Windows keeps them so a device could roll back, and never cleans them up.
//
// Only a package that has a NEWER version of itself in the store is offered,
// and never one a device is using. The newest version of every driver stays, so
// no device can end up without one. pnputil runs without /force, which makes
// Windows refuse anything still bound to a device as a second line of defence.
//
// Removal is not undoable - the package is gone - so nothing is pre-selected
// and every removal is written to the history as a record.

const path = require("path");
const crypto = require("crypto");
const { run, runPsJson } = require("./shell");

const INF_RE = /^oem\d+\.inf$/i;

// "31.0.15.3623" vs "31.0.15.4601", numerically per part.
function compareVersions(a, b) {
    const pa = String(a || "").split(".").map((x) => Number.parseInt(x, 10) || 0);
    const pb = String(b || "").split(".").map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

// The same driver is the same original .inf from the same provider for the same
// device class. Anything below the newest of its group, and not in use, is
// superseded.
function superseded(drivers) {
    const groups = new Map();
    for (const d of drivers || []) {
        if (!INF_RE.test(d.inf || "")) continue;
        const key = [d.original, d.provider, d.className].map((x) => String(x || "").toLowerCase()).join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
    }
    const out = [];
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const newest = list.reduce((best, d) =>
            compareVersions(d.version, best.version) > 0 ||
            (compareVersions(d.version, best.version) === 0 && d.date > best.date)
                ? d
                : best
        );
        for (const d of list) {
            if (d !== newest && !d.inUse) out.push({ ...d, newerVersion: newest.version });
        }
    }
    return out.sort((a, b) => b.bytes - a.bytes);
}

async function listOldDrivers() {
    const res = await runPsJson(path.join(__dirname, "ps", "drivers.ps1"), undefined, null);
    if (!res.ok || !res.data) return { ok: false, error: res.error || "Could not read the driver store", drivers: [] };
    if (!res.data.ok) return { ok: false, error: res.data.error, drivers: [] };
    return { ok: true, error: null, drivers: superseded(res.data.drivers) };
}

// The renderer only names packages. What gets deleted is the intersection with
// a fresh listing, so a stale or tampered list can never reach a driver that is
// current or in use.
async function removeOldDrivers(infs, { history, onProgress = null } = {}) {
    const listing = await listOldDrivers();
    if (!listing.ok) return { results: [], summary: { total: 0, removed: 0, failed: 0 }, error: listing.error };
    const allowed = new Map(listing.drivers.map((d) => [d.inf.toLowerCase(), d]));

    const results = [];
    const wanted = [...new Set((infs || []).map((x) => String(x).toLowerCase()))];
    for (let i = 0; i < wanted.length; i++) {
        const inf = wanted[i];
        const d = allowed.get(inf);
        if (onProgress) onProgress({ index: i, total: wanted.length, tweakId: inf, name: d ? `${d.provider} ${d.version}` : inf });
        if (!d) {
            results.push({ inf, ok: false, error: "Not a superseded driver package" });
            continue;
        }
        const res = await run("pnputil.exe", ["/delete-driver", d.inf], { timeout: 120_000 });
        const result = { inf: d.inf, ok: res.ok, error: res.ok ? null : res.stdout.split(/\r?\n/).pop() || res.error };
        results.push(result);

        if (history) {
            history({
                id: crypto.randomUUID(),
                tweakId: `driver:${d.inf}`,
                tweakName: `${d.provider} ${d.className} ${d.version}`,
                risk: "safe",
                kind: "drivers",
                appliedAt: new Date().toISOString(),
                status: res.ok ? "applied" : "failed",
                verified: res.ok,
                undoneAt: null,
                requiresRestart: false,
                undoable: false,
                ops: [
                    {
                        op: { type: "driverPackage", inf: d.inf },
                        describe: `Delete driver package ${d.inf} (${d.original}, ${d.version}) - superseded by ${d.newerVersion}`,
                        previous: null,
                        undoable: false,
                        result: { ok: res.ok, error: result.error, warning: null, detail: null },
                    },
                ],
            });
        }
    }
    return {
        results,
        summary: {
            total: results.length,
            removed: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
        },
    };
}

module.exports = { listOldDrivers, removeOldDrivers, superseded, compareVersions };
