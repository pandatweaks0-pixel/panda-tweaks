"use strict";

// The debloat list is built from what is really installed, with the catalogue
// folded in for names and recommendations. These tests cover that merge — the
// part that decides what the user is offered and what stays untouchable.

const test = require("node:test");
const assert = require("node:assert");
const { mergeDebloatCatalogue, friendlyAppName, classifyApp } = require("../src/main/engine");

const CATALOGUE = [
    { id: "bloat_todos", package: "Todos", name: "Microsoft To Do", description: "Tasks.", recommended: true, risk: "safe" },
    { id: "bloat_news", package: "BingNews", name: "Microsoft News", description: "News.", recommended: true, risk: "safe" },
];

const app = (pkg, extra = {}) => ({ package: pkg, publisher: "", version: "1.0", protected: false, ...extra });

test("an installed app the catalogue never described is still offered", () => {
    const merged = mergeDebloatCatalogue(CATALOGUE, [app("Microsoft.OutlookForWindows")]);
    const entry = merged.find((e) => e.package === "Microsoft.OutlookForWindows");

    assert.ok(entry, "unknown installed apps must appear — the old catalogue-only list hid them");
    assert.equal(entry.installed, true);
    assert.equal(entry.known, false);
    assert.equal(entry.recommended, false, "never recommend removing something the app cannot describe");
    assert.equal(entry.risk, "advanced");
});

test("a catalogue entry matches the real package name and keeps its description", () => {
    const merged = mergeDebloatCatalogue(CATALOGUE, [app("Microsoft.Todos")]);
    const entry = merged.find((e) => e.package === "Microsoft.Todos");

    assert.equal(entry.name, "Microsoft To Do");
    assert.equal(entry.recommended, true);
    assert.equal(entry.known, true);
    assert.deepEqual(entry.resolved, ["Microsoft.Todos"], "removal must target the exact installed name");
});

test("catalogue entries that are not installed survive, but sort last", () => {
    const merged = mergeDebloatCatalogue(CATALOGUE, [app("Microsoft.Todos")]);
    const news = merged.find((e) => e.package === "BingNews");

    assert.equal(news.installed, false, "nothing the data file promised is silently dropped");
    assert.equal(merged.indexOf(news), merged.length - 1, "absent entries must not bury actionable ones");
});

test("a protected package is marked, not hidden", () => {
    const merged = mergeDebloatCatalogue(CATALOGUE, [app("Microsoft.WindowsStore", { protected: true })]);
    const store = merged.find((e) => e.package === "Microsoft.WindowsStore");

    assert.ok(store, "present-but-untouchable is a different fact from absent");
    assert.equal(store.protected, true);
});

test("friendly names drop the publisher segment and split CamelCase", () => {
    assert.equal(friendlyAppName("MicrosoftCorporationII.QuickAssist"), "Quick Assist");
    assert.equal(friendlyAppName("Microsoft.WindowsCalculator"), "Windows Calculator");
    assert.equal(friendlyAppName("MicrosoftWindows.CrossDevice"), "Cross Device");
    assert.equal(friendlyAppName("12030rocksdanister.LivelyWallpaper"), "Lively Wallpaper");
    assert.ok(friendlyAppName("MSTeams").length, "a name without a dot still yields something");
});

test("codecs and runtimes are sorted away from ordinary apps", () => {
    const of = (pkg, publisher = "Microsoft Corporation") =>
        classifyApp({ package: pkg, publisher, isProtected: false, recommended: false, installed: true });

    // Removing any of these breaks playback, games or the Store itself.
    assert.equal(of("Microsoft.AV1VideoExtension"), "components");
    assert.equal(of("Microsoft.HEVCVideoExtension"), "components");
    assert.equal(of("MicrosoftCorporationII.WinAppRuntime.Main.1.8"), "components");
    assert.equal(of("Microsoft.LanguageExperiencePackde-DE"), "components");
    assert.equal(of("MicrosoftWindows.Client.WebExperience"), "components");

    // Ordinary apps stay decidable.
    assert.equal(of("Microsoft.OutlookForWindows"), "preinstalled");
    assert.equal(of("Microsoft.WindowsCalculator"), "preinstalled");
    assert.equal(of("SpotifyAB.SpotifyMusic", "Spotify AB"), "thirdparty");
    assert.equal(of("WinRAR.ShellExtension", "win.rar GmbH"), "thirdparty");
});

test("a protected package is never grouped as an ordinary app", () => {
    const g = classifyApp({
        package: "Microsoft.WindowsStore",
        publisher: "Microsoft Corporation",
        isProtected: true,
        recommended: false,
        installed: true,
    });
    assert.equal(g, "components");
});

test("recommendation outranks classification", () => {
    const g = classifyApp({
        package: "Microsoft.BingNews",
        publisher: "Microsoft Corporation",
        isProtected: false,
        recommended: true,
        installed: true,
    });
    assert.equal(g, "recommended", "what the app suggests removing must surface at the top");
});

// A row nobody can identify is a row nobody can decide about. Microsoft's
// package ids are not product names: Microsoft.ScreenSketch is the Snipping
// Tool, and offering it as "Screen Sketch" — the name derived from the id —
// is how it got removed from a real machine by someone who never meant to.
test("packages Windows ships under a different name carry their real one", () => {
    const catalogue = require("../src/data/debloat.json");
    const app = (pkg) => ({ package: pkg, publisher: "Microsoft Corporation", version: "1", protected: false });

    const merged = mergeDebloatCatalogue(catalogue, [app("Microsoft.ScreenSketch")]);
    const snip = merged.find((e) => e.package === "Microsoft.ScreenSketch");

    assert.equal(snip.name, "Snipping Tool", "the derived name would have been 'Screen Sketch'");
    assert.equal(snip.known, true);
    assert.equal(snip.recommended, false, "a tool people use is never suggested for removal");
    assert.equal(snip.keep, true, "and it is marked as one to keep");
});

test("an exact catalogue match beats a shorter fragment", () => {
    const catalogue = [
        { id: "frag", package: "Paint", name: "Wrong Match", recommended: true, risk: "safe" },
        { id: "exact", package: "Microsoft.Paint", name: "Paint", recommended: false, risk: "advanced", keep: true },
    ];
    const merged = mergeDebloatCatalogue(catalogue, [
        { package: "Microsoft.Paint", publisher: "Microsoft Corporation", version: "1", protected: false },
    ]);
    const paint = merged.find((e) => e.package === "Microsoft.Paint");

    assert.equal(paint.name, "Paint", "substring matching must not let a short entry shadow a specific one");
    assert.equal(paint.keep, true);
});
