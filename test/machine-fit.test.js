"use strict";

// Does a tweak suit THIS machine? The rule that decides whether a preset hands
// a laptop seven tweaks that empty its battery, or turns prefetching off on a
// spinning disk where it was helping.

const test = require("node:test");
const assert = require("node:assert");
const { machineFit } = require("../src/main/analyzer");

const DESKTOP = { isLaptop: false, systemDriveType: "SSD", ram: { totalGB: 32 } };
const LAPTOP = { ...DESKTOP, isLaptop: true };

const powerTweak = { id: "cpu_minstate100", operations: [{ type: "powercfg", action: "setting" }] };
const throttleTweak = { id: "cpu_powerthrottle_off", operations: [{ type: "registry" }] };
const prefetch = { id: "mem_prefetch_off", operations: [{ type: "registry" }] };
const pagingExec = { id: "cpu_pagingexec", operations: [{ type: "registry" }] };
const ordinary = { id: "win_game_mode", operations: [{ type: "registry" }] };

test("an ordinary tweak fits any machine", () => {
    assert.equal(machineFit(ordinary, DESKTOP), null);
    assert.equal(machineFit(ordinary, LAPTOP), null);
    assert.equal(machineFit(ordinary, {}), null, "an empty analysis must not block everything");
});

test("power tweaks are withheld on a laptop and allowed on a desktop", () => {
    assert.equal(machineFit(powerTweak, DESKTOP), null);
    assert.equal(machineFit(powerTweak, LAPTOP), "skipped.laptopBattery");
});

// The rule reads the operations rather than a hand-kept list, so a powercfg
// tweak added next year is covered without anyone remembering this file.
test("any powercfg operation counts as draining, whatever the tweak is called", () => {
    const invented = { id: "something_nobody_has_written_yet", operations: [{ type: "powercfg" }] };
    assert.equal(machineFit(invented, LAPTOP), "skipped.laptopBattery");
});

// ...and the one battery tweak that is not powercfg still has to be named.
test("the named exception is caught even though it is a registry write", () => {
    assert.equal(machineFit(throttleTweak, LAPTOP), "skipped.laptopBattery");
    assert.equal(machineFit(throttleTweak, DESKTOP), null);
});

test("prefetch is only turned off on a drive known to be an SSD", () => {
    assert.equal(machineFit(prefetch, DESKTOP), null);
    assert.equal(machineFit(prefetch, { ...DESKTOP, systemDriveType: "HDD" }), "skipped.needsSsd");
    assert.equal(machineFit(prefetch, { ...DESKTOP, systemDriveType: "ssd" }), null, "casing must not decide this");
});

// Unproven is treated as not fitting here, which is the opposite of how a
// failed read is treated elsewhere — and deliberately so. Detection reports what
// is; this decides what to do unasked, and "I cannot tell whether this helps or
// hurts" is not a reason to do it to someone.
test("an unknown drive type withholds rather than guesses", () => {
    const reason = machineFit(prefetch, { ...DESKTOP, systemDriveType: null });
    assert.equal(reason, "skipped.driveUnknown");
    assert.notEqual(reason, "skipped.needsSsd", "say we could not tell, not that it is a hard disk");
});

test("keeping the kernel in RAM needs enough RAM to spare", () => {
    assert.equal(machineFit(pagingExec, DESKTOP), null);
    assert.equal(machineFit(pagingExec, { ...DESKTOP, ram: { totalGB: 8 } }), "skipped.needsRam");
    assert.equal(machineFit(pagingExec, { ...DESKTOP, ram: { totalGB: 16 } }), null, "16 GB is the line, not above it");
    assert.equal(machineFit(pagingExec, { ...DESKTOP, ram: {} }), "skipped.ramUnknown");
});

// Every reason this can return has to exist in both languages, or the dialog
// shows a raw key like "skipped.needsSsd" to the user.
test("every reason has a translation in both languages", () => {
    const en = require("../src/data/locales/en.json");
    const de = require("../src/data/locales/de.json");

    const reasons = new Set();
    for (const analysis of [
        LAPTOP,
        { ...DESKTOP, systemDriveType: "HDD" },
        { ...DESKTOP, systemDriveType: null },
        { ...DESKTOP, ram: { totalGB: 8 } },
        { ...DESKTOP, ram: {} },
    ]) {
        for (const tweak of [powerTweak, throttleTweak, prefetch, pagingExec]) {
            const r = machineFit(tweak, analysis);
            if (r) reasons.add(r);
        }
    }
    reasons.add("skipped.risky"); // returned by recommend(), same dialog

    assert.ok(reasons.size >= 5, `expected every branch to be exercised, got ${[...reasons].join(", ")}`);
    for (const key of reasons) {
        assert.ok(en[key], `en.json is missing ${key}`);
        assert.ok(de[key], `de.json is missing ${key}`);
    }
});
