"use strict";

// Catalogue-wide consistency. These read the shipped data and nothing else — no
// registry, no elevation, no processes.
//
// They exist because of a bug the type system could not catch: two tweaks wrote
// the same registry value to different numbers. Both were valid operations,
// both validated, both applied cleanly, and whichever ran second silently undid
// the first. Worse, the second one captured the FIRST one's value as "what was
// here before", so undo restored a state the user had never been in — which is
// the one promise this whole app is built on.

const test = require("node:test");
const assert = require("node:assert");
const { validateOp } = require("../src/main/ops");
const tweaks = require("../src/data/tweaks.json");

const usable = tweaks.filter((t) => {
    try {
        (t.operations || []).forEach(validateOp);
        return true;
    } catch {
        return false;
    }
});

// The thing an operation ultimately writes to, in a form two operations can be
// compared on. Types without a single addressable target are left out.
function targetOf(op) {
    switch (op.type) {
        case "registry":
            return `registry ${op.hive}\\${op.key}\\${op.name}`;
        case "service":
            return `service ${op.name}`;
        case "scheduledTask":
            return `task ${op.path}`;
        case "netsh":
            return `netsh ${op.setting}`;
        case "powercfg":
            return op.action === "hibernate" ? "powercfg hibernate" : `powercfg ${op.setting}`;
        case "cleanup":
            return `cleanup ${op.target}`;
        case "appx":
            return `appx ${op.package}`;
        case "command":
            return `command ${op.command}`;
        case "startup":
            return `startup ${op.scope}\\${op.name}`;
        default:
            return null;
    }
}

function valueOf(op) {
    switch (op.type) {
        case "registry":
            return op.action === "delete" ? "(deleted)" : String(op.value);
        case "service":
            return op.startMode;
        case "scheduledTask":
            return String(op.enabled);
        case "netsh":
            return op.value;
        case "powercfg":
            return String(op.action === "hibernate" ? op.enabled : op.value);
        case "cleanup":
        case "appx":
            return "(removed)";
        case "command":
            return "(run)";
        case "startup":
            return String(op.enabled);
        default:
            return null;
    }
}

function writersByTarget() {
    const map = new Map();
    for (const tweak of usable) {
        for (const op of tweak.operations || []) {
            const target = targetOf(op);
            if (!target) continue;
            if (!map.has(target)) map.set(target, []);
            map.get(target).push({ id: tweak.id, value: valueOf(op) });
        }
    }
    return map;
}

test("no two tweaks write the same target to different values", () => {
    const conflicts = [];
    for (const [target, writers] of writersByTarget()) {
        const values = new Set(writers.map((w) => w.value));
        if (values.size > 1) {
            conflicts.push(`${target}\n    ` + writers.map((w) => `${w.id} -> ${w.value}`).join("\n    "));
        }
    }
    assert.deepEqual(
        conflicts,
        [],
        "these cancel each other out, and undo restores whatever the other one set:\n  " + conflicts.join("\n  ")
    );
});

// Two tweaks agreeing on a value is not a correctness problem, but it does mean
// the catalogue counts one change twice — the padding this app's own website
// criticises other tools for.
test("no tweak is a duplicate of another", () => {
    // Operations with no addressable target cannot be compared, and pretending
    // they can is how this test first reported four unrelated cleanup tweaks as
    // copies of each other: every one of them signed as "null=null".
    const signature = (t) =>
        (t.operations || [])
            .filter((op) => targetOf(op) !== null)
            .map((op) => `${targetOf(op)}=${valueOf(op)}`)
            .sort()
            .join(" | ");

    const seen = new Map();
    const duplicates = [];
    for (const t of usable) {
        const sig = signature(t);
        if (!sig) continue;
        if (seen.has(sig)) duplicates.push(`${t.id} is identical to ${seen.get(sig)}`);
        else seen.set(sig, t.id);
    }
    assert.deepEqual(duplicates, [], duplicates.join("\n  "));
});

test("every tweak has an id, a name and at least one operation", () => {
    const problems = [];
    const ids = new Set();
    for (const t of tweaks) {
        if (!t.id) problems.push(`a tweak has no id: ${t.name || "(unnamed)"}`);
        else if (ids.has(t.id)) problems.push(`duplicate id: ${t.id}`);
        else ids.add(t.id);
        if (!t.name) problems.push(`${t.id}: no name`);
        if (!t.description) problems.push(`${t.id}: no description`);
        if (!(t.operations || []).length) problems.push(`${t.id}: no operations`);
        if (!["safe", "advanced", "risky"].includes(t.risk)) problems.push(`${t.id}: risk is "${t.risk}"`);
    }
    assert.deepEqual(problems, [], problems.join("\n  "));
});

// A risky tweak that is also marked "recommended" would be offered
// automatically, which the analyzer is written never to do.
test("nothing risky is marked as recommended", () => {
    const bad = tweaks.filter((t) => t.risk === "risky" && t.recommended).map((t) => t.id);
    assert.deepEqual(bad, [], "risky tweaks are opt-in and must never be suggested on their own");
});
