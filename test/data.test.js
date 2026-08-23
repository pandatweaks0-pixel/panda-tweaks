"use strict";

// Guards the shipped data files: the tweak catalogue, the debloat list and the
// locale files. These catch a bad conversion run before it reaches a user.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const engine = require("../src/main/engine");
const { OPS } = require("../src/main/ops");
const logger = require("../src/main/logger");
const os = require("os");

const DATA = path.join(__dirname, "..", "src", "data");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

logger.init(os.tmpdir());
const loadResult = engine.loadTweaks(DATA);

test("the tweak catalogue loads", () => {
    assert.equal(loadResult.ok, true);
    assert.ok(loadResult.count > 100, `expected a substantial catalogue, got ${loadResult.count}`);
});

test("every tweak has the fields the UI relies on", () => {
    for (const tweak of engine.getTweaks()) {
        assert.ok(tweak.id, "tweak needs an id");
        assert.ok(tweak.name, `${tweak.id} needs a name`);
        assert.ok(tweak.description, `${tweak.id} needs a description`);
        assert.ok(["safe", "advanced", "risky"].includes(tweak.risk), `${tweak.id} has risk "${tweak.risk}"`);
        assert.equal(typeof tweak.requiresAdmin, "boolean");
        assert.equal(typeof tweak.undoable, "boolean");
        assert.ok(Array.isArray(tweak.affected));
    }
});

test("tweak ids are unique", () => {
    const ids = engine.getTweaks().map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
});

test("risky tweaks are never marked recommended", () => {
    for (const tweak of engine.getTweaks()) {
        if (tweak.risk === "risky") {
            assert.equal(tweak.recommended, false, `${tweak.id} is risky and must not be recommended`);
        }
    }
});

test("every operation that cannot be undone is an explicit one-time action", () => {
    // The only operations allowed to ship without an undo are the ones the UI
    // presents as one-time actions: deleting files, removing an app, and running
    // a repair tool. Each is a deliberate entry on this list — a new operation
    // type does not get to be non-undoable by default.
    //
    // The check is per operation, not per tweak: a repair may legitimately
    // combine reversible service changes with an irreversible cache clear, and
    // undo then restores what it can and says so for the rest.
    const ONE_TIME = new Set(["cleanup", "appx", "command"]);

    for (const tweak of engine.getTweaks()) {
        if (tweak.unavailable) continue;
        for (const op of tweak.operations) {
            if (OPS[op.type].undoable) continue;
            assert.ok(
                ONE_TIME.has(op.type),
                `${tweak.id} uses operation type "${op.type}", which has no undo and is not a declared one-time action`
            );
        }
    }
});

test("tweaks that could not be converted are flagged, not silently broken", () => {
    const unavailable = engine.getTweaks().filter((t) => t.unavailable);
    for (const tweak of unavailable) {
        assert.match(
            tweak.unavailable,
            /not implemented yet|entire registry key|unrecognised|without/i,
            `${tweak.id} needs a readable reason, got: ${tweak.unavailable}`
        );
    }
    // Every unavailable tweak keeps its original command for later conversion.
    const raw = read("tweaks.json");
    for (const tweak of unavailable) {
        const source = raw.find((r) => r.id === tweak.id);
        assert.ok(source.originalCommand, `${tweak.id} lost its original command`);
    }
});

test("status is derived correctly from the operations", () => {
    const tweak = engine.getTweaks().find((t) => !t.unavailable && t.operations.length >= 2);
    assert.ok(tweak, "need a multi-operation tweak for this test");

    const allApplied = new Map(tweak.operations.map((op) => [op, { exists: true, value: op.value, valueType: op.valueType }]));
    assert.equal(engine.statusFromOps(tweak, allApplied).status, "applied");

    const none = new Map(tweak.operations.map((op) => [op, { exists: false }]));
    assert.equal(engine.statusFromOps(tweak, none).status, "not-applied");

    const mixed = new Map(tweak.operations.map((op, i) => [op, i === 0 ? { exists: true, value: op.value, valueType: op.valueType } : { exists: false }]));
    assert.equal(engine.statusFromOps(tweak, mixed).status, "partial");

    const unreadable = new Map(tweak.operations.map((op) => [op, { readFailed: true }]));
    assert.equal(engine.statusFromOps(tweak, unreadable).status, "unknown");
});

test("debloat entries carry a real package fragment, never an internal id", () => {
    const apps = read("debloat.json");
    assert.ok(apps.length > 20);
    for (const app of apps) {
        assert.ok(app.package, `${app.id} has no package`);
        assert.ok(
            !app.package.startsWith("bloat_"),
            `${app.id} has "${app.package}" as its package — that is the catalogue id, not a package name`
        );
        assert.ok(app.name, `${app.id} needs a display name`);
    }
});

test("English and German locales define exactly the same keys", () => {
    const en = read(path.join("locales", "en.json"));
    const de = read(path.join("locales", "de.json"));

    const missingInDe = Object.keys(en).filter((k) => !(k in de));
    const missingInEn = Object.keys(de).filter((k) => !(k in en));

    assert.deepEqual(missingInDe, [], "keys present in English but missing in German");
    assert.deepEqual(missingInEn, [], "keys present in German but missing in English");
});

test("locale placeholders match between languages", () => {
    const en = read(path.join("locales", "en.json"));
    const de = read(path.join("locales", "de.json"));
    const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();

    for (const key of Object.keys(en)) {
        assert.deepEqual(
            placeholders(de[key]),
            placeholders(en[key]),
            `placeholders differ for "${key}": en=${en[key]} de=${de[key]}`
        );
    }
});

test("no locale string is left empty", () => {
    for (const file of ["en.json", "de.json"]) {
        const strings = read(path.join("locales", file));
        for (const [key, value] of Object.entries(strings)) {
            assert.ok(String(value).trim(), `${file}: "${key}" is empty`);
        }
    }
});

test("every locale key the UI asks for exists", () => {
    // Scans the renderer for t("...") calls and checks each against the catalogue.
    const rendererDir = path.join(__dirname, "..", "src", "renderer");
    const used = new Set();
    for (const file of fs.readdirSync(rendererDir).filter((f) => f.endsWith(".js"))) {
        const source = fs.readFileSync(path.join(rendererDir, file), "utf8");
        for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.\-]+)"/g)) {
            used.add(match[1]);
        }
    }
    const en = read(path.join("locales", "en.json"));
    const missing = [...used].filter((key) => !(key in en)).sort();
    assert.deepEqual(missing, [], "renderer references locale keys that do not exist");
});
