"use strict";

// Builds src/data/presets.json.
//
// Presets are curation, not derivation - which is exactly why they are built
// here instead of hand-edited. A flat list of fifty ids in a JSON file tells
// nobody why a tweak is in the Valorant preset and not in the GTA V one, and
// the first person to add a tweak has no idea which presets should get it.
//
// Two rules hold across every preset:
//
//   Nothing risky. A preset is the button people press without reading, so it
//   only ever contains tweaks that are safe or advanced.
//
//   No display-driver tweaks. HAGS, MPO and TdrDelay are the only three in the
//   catalogue whose outcome depends on your specific driver, and whose failure
//   mode is a black or flickering screen - the one state in which you cannot
//   reach the undo button. They stay available individually, where the person
//   applying them chose them deliberately and knows what to blame.
//
//   node tools/build-presets.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TWEAKS = path.join(ROOT, "src", "data", "tweaks.json");
const OUT = path.join(ROOT, "src", "data", "presets.json");

const { validateOp } = require(path.join(ROOT, "src", "main", "ops"));
const tweaks = JSON.parse(fs.readFileSync(TWEAKS, "utf8"));

const usable = (t) => {
    try {
        (t.operations || []).forEach(validateOp);
        return true;
    } catch {
        return false;
    }
};
const byId = new Map(tweaks.map((t) => [t.id, t]));

// --------------------------------------------------------------- groups --

// Wins on any machine running any game, with no trade-off worth explaining.
const BASE = [
    "win_game_mode", "win_gamedvr_off", "win_gamebar_off", "win_visualfx",
    "win_transparency_off", "win_menu_delay", "win_startup_delay",
    "win_window_anim_off", "win_taskbar_anim_off", "win_aeroshake_off",
    "win_snap_flyout_off", "win_error_reporting_off", "str_notifications_off",
    "str_historical_capture_off", "aud_ducking_off", "mem_background_off",
    "dsp_dynamic_lighting_off",
];

// Mouse and keyboard latency. Worth everything in a shooter, worth very little
// in a game you steer with a controller through traffic.
const INPUT = [
    "win_mouse_accel_off", "win_stickykeys_off", "in_kbd_repeat", "in_mouse_queue",
    "in_kbd_queue", "in_hover_time", "in_filterkeys_off", "in_togglekeys_off",
    "in_langhotkey_off", "in_accessibility_off", "in_mouse_polish",
    "in_default_sens", "in_fg_lock", "in_thread_priority", "in_xbox_button_off",
];

// The parts of INPUT that still matter when you are not aiming: pointer
// behaviour and window focus, without the micro-latency buffer tuning.
const INPUT_LIGHT = ["win_mouse_accel_off", "in_default_sens", "in_fg_lock"];

// Tell Windows the foreground game outranks everything else.
const SCHED = ["cpu_priority", "cpu_mmcss", "cpu_mmcss_games", "cpu_global_timer", "aud_mmcss"];

// Keep the hardware awake. Costs heat and power on a desktop, costs a laptop
// its battery - which is why the apply flow filters these on a portable.
const POWER = [
    "cpu_minstate100", "cpu_coreparking_off", "cpu_powerthrottle_off",
    "cpu_usb_suspend_off", "cpu_pcie_aspm_off", "cpu_idle_off", "dsp_never_sleep",
];

// Memory and disk behaviour. Pays off in a game that streams a large world off
// disk; near-pointless in one that loads a small map once and stays there.
const STREAMING = ["cpu_pagingexec", "mem_sysmain_off", "mem_prefetch_off", "mem_clearpagefile"];

// Browsers left running in the background during a session.
const BROWSERS = ["app_chrome_bg_off", "app_edge_bg_off", "app_edge_boost_off"];

// Teredo is deliberately absent. Turning it off is a fine tweak on its own, but
// Xbox networking and party chat lean on it, so a preset that silently killed
// someone's multiplayer would be the kind of surprise these are meant to avoid.
// It stays applicable by hand.
const NET = [
    "net_throttle_off", "net_qos_off", "net_do_off", "net_timedwait",
    "net_maxuserport", "net_llmnr_off", "net_defaultttl",
    "net_tcp_optimize", "net_rsc_off", "net_ecn_off", "net_timestamps_off",
    "net_heuristics_off",
];

const FSO = ["win_fso_off"];
const DX = ["dsp_dx_settings"];

// The only group in this file that is about one game rather than one kind of
// game. Exclusive fullscreen is the largest single latency change available
// here: borderless windowed sends every frame through the desktop compositor,
// which costs a whole frame, and no Windows setting can give that back. The two
// halves belong together - the game's own setting asks for exclusive fullscreen,
// the Windows one stops it being quietly converted back.
//
// game_retrac_priority is deliberately absent. It is only "advanced", so the
// rule at the top of this file would allow it, but it writes to the registry
// branch debuggers attach through and Retrac ships an undocumented kernel
// anti-cheat. That is a decision to make deliberately, not one to inherit from
// a button you pressed without reading. It stays available on its own.
const RETRAC = ["game_retrac_exclusive_fs", "game_retrac_fso", "game_retrac_gpu"];

// The same idea for the official game, and the reason there is only one entry
// here. Epic stopped honouring edits to the other ini files in patch 1.7.2 and
// treats them as a rules violation - people were using them to strip fog and
// widen the field of view. GameUserSettings.ini is the one file Epic says is
// meant to be edited, and this value is one the game's own video options set
// anyway. Everything else people post as a "Fortnite ini tweak" belongs to the
// files that stopped working eight years ago.
const FORTNITE_GAME = ["game_fortnite_exclusive_fs"];

// Never in a preset - see the header.
const DISPLAY_DRIVER = new Set(["gpu_hags", "gpu_mpo_off", "gpu_tdrdelay"]);

// ----------------------------------------------------------- compositions --

const PRESETS = [
    {
        id: "fortnite",
        name: "FORTNITE",
        short: "FN",
        color: "#3AA6E0",
        tagline: "Maximum FPS, minimum input lag",
        groups: [BASE, INPUT, SCHED, POWER, NET, BROWSERS, FSO, DX, FORTNITE_GAME],
    },
    {
        id: "valorant",
        name: "VALORANT",
        short: "VAL",
        color: "#FF4655",
        tagline: "Lowest input delay, steady frames",
        // No STREAMING: the maps are small and load once, so trading memory
        // behaviour for load times buys nothing here.
        groups: [BASE, INPUT, SCHED, POWER, NET, BROWSERS, FSO],
    },
    {
        id: "retrac",
        name: "PROJECT RETRAC",
        short: "RTC",
        color: "#4ADE80",
        tagline: "Exclusive fullscreen and the CPU first",
        // No STREAMING: it is a Chapter 2 map loaded once, same as Valorant.
        // The RETRAC group is what makes this preset genuinely different from
        // the others rather than the same list under a new name.
        groups: [BASE, INPUT, SCHED, POWER, NET, BROWSERS, FSO, RETRAC],
    },
    {
        id: "gta5",
        name: "GTA V",
        short: "GTA",
        color: "#7FB800",
        tagline: "Smooth streaming, fewer hitches",
        // INPUT_LIGHT rather than INPUT: hitching while the world streams in is
        // the complaint here, not a millisecond of mouse latency.
        groups: [BASE, INPUT_LIGHT, SCHED, POWER, NET, BROWSERS, STREAMING, DX],
    },
];

// ------------------------------------------------------------------ build --

const problems = [];
const resolve = (ids, presetId) => {
    const out = [];
    for (const id of ids) {
        const t = byId.get(id);
        if (!t) problems.push(`${presetId}: no such tweak "${id}"`);
        else if (!usable(t)) problems.push(`${presetId}: "${id}" is not usable (unsupported operation)`);
        else if (t.risk === "risky") problems.push(`${presetId}: "${id}" is risky and must not be in a preset`);
        else if (DISPLAY_DRIVER.has(id)) problems.push(`${presetId}: "${id}" is a display-driver tweak and must not be in a preset`);
        else out.push(id);
    }
    return [...new Set(out)];
};

const built = PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    short: p.short,
    color: p.color,
    tagline: p.tagline,
    ids: resolve(p.groups.flat(), p.id),
}));

// A typo in a group above would otherwise ship as a quietly smaller preset.
if (problems.length) {
    console.error("Refusing to write presets.json:");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(built, null, 2) + "\n", "utf8");

console.log("presets.json written");
for (const p of built) console.log(`  ${p.id.padEnd(10)} ${String(p.ids.length).padStart(3)} tweaks`);

// How different are they actually? A preset that is 95% another preset is a
// second name for the same button, and that is worth seeing at build time.
console.log("\noverlap:");
for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
        const a = new Set(built[i].ids);
        const b = new Set(built[j].ids);
        const shared = [...a].filter((x) => b.has(x)).length;
        const union = new Set([...a, ...b]).size;
        console.log(`  ${built[i].id.padEnd(9)} vs ${built[j].id.padEnd(9)} ${Math.round((shared / union) * 100)}% identical`);
    }
}
