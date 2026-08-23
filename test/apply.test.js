"use strict";

// What counts as proof that a change took effect.
//
// Applying reads the values back afterwards, and a write that did not stick is
// reported as unverified rather than as a success. But some operations have no
// state to read: flushing the DNS cache, running sfc, deleting a temp folder.
// Counting those as "not verified" made every repair report as incomplete even
// when every single step had succeeded — the same mistake as treating a failed
// read as a failure.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const engine = require("../src/main/engine");

engine.loadTweaks(path.join(__dirname, "..", "src", "data"));

const byId = (id) => {
    const tweak = engine.getTweak(id);
    assert.ok(tweak, `${id} should exist in the catalogue`);
    return tweak;
};

test("operations with no readable state are not counted as evidence", () => {
    // Four command operations: winsock, ip reset, autotuning, DNS flush.
    const network = byId("fix_network");
    assert.ok(network.operations.length > 0);
    assert.equal(
        engine.verifiableOps(network).length,
        0,
        "nothing here can be read back, so there is nothing to verify against"
    );
});

test("a repair that mixes readable and unreadable steps is judged on the readable ones", () => {
    // Stops two services, clears the update cache, starts them again.
    const update = byId("fix_update");
    const verifiable = engine.verifiableOps(update);

    assert.ok(verifiable.length > 0, "the service steps are readable");
    assert.ok(verifiable.length < update.operations.length, "the cleanup step is not");
    assert.ok(
        verifiable.every((op) => op.type === "service"),
        "only the service operations should be used as evidence"
    );
});

test("ordinary tweaks are still verified in full", () => {
    const registryOnly = engine.getTweaks().find((t) => !t.unavailable && t.operations.every((op) => op.type === "registry"));

    assert.ok(registryOnly, "the catalogue should contain a registry-only tweak");
    assert.equal(
        engine.verifiableOps(registryOnly).length,
        registryOnly.operations.length,
        "a registry write can always be read back, and must be"
    );
});
