"use strict";

// The complete surface the renderer can reach.
//
// There is deliberately no "run this command" handler. Every channel below
// takes structured arguments and maps them onto a typed operation, so a
// compromised or buggy renderer cannot execute arbitrary code — which matters
// because this process may be running elevated.

const { ipcMain, shell, app, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const engine = require("./engine");
const analyzer = require("./analyzer");
const restore = require("./restore");
const settings = require("./settings");
const logger = require("./logger");
const { isAdmin, elevate } = require("./elevation");

let dataDir = null;

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    } catch (e) {
        logger.error(`Could not read ${file}`, { error: e.message });
        return fallback;
    }
}

function register({ getWindow, dataDirectory }) {
    dataDir = dataDirectory;

    // --- window ------------------------------------------------------------
    ipcMain.on("window:minimize", () => getWindow()?.minimize());
    ipcMain.on("window:maximize", () => {
        const w = getWindow();
        if (!w) return;
        w.isMaximized() ? w.unmaximize() : w.maximize();
    });
    ipcMain.on("window:close", () => getWindow()?.close());
    ipcMain.handle("window:isMaximized", () => getWindow()?.isMaximized() ?? false);

    // --- app ---------------------------------------------------------------
    ipcMain.handle("app:info", () => ({
        version: app.getVersion(),
        isAdmin: isAdmin(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        logPath: logger.getPath(),
        dataPath: app.getPath("userData"),
    }));
    ipcMain.handle("app:requestAdmin", () => elevate());
    ipcMain.handle("app:openExternal", async (_e, url) => {
        // Only http(s) leaves the app, and it opens in the user's browser.
        if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
            return { ok: false, error: "Only https links can be opened" };
        }
        await shell.openExternal(url);
        return { ok: true };
    });
    ipcMain.handle("app:showItemInFolder", (_e, which) => {
        const targets = { log: logger.getPath(), data: app.getPath("userData") };
        const target = targets[which];
        if (!target) return { ok: false, error: "Unknown location" };
        shell.showItemInFolder(target);
        return { ok: true };
    });

    // --- settings ----------------------------------------------------------
    ipcMain.handle("settings:get", () => settings.getAll());
    ipcMain.handle("settings:set", (_e, patch) => settings.set(patch));
    ipcMain.handle("settings:reset", () => settings.reset());

    // --- locales -----------------------------------------------------------
    ipcMain.handle("i18n:load", (_e, lang) => {
        const safe = /^[a-z]{2}$/.test(String(lang)) ? String(lang) : "en";
        const file = path.join(dataDir, "locales", `${safe}.json`);
        try {
            return { ok: true, lang: safe, strings: JSON.parse(fs.readFileSync(file, "utf8")) };
        } catch (e) {
            return { ok: false, lang: safe, strings: {}, error: e.message };
        }
    });

    // --- analysis ----------------------------------------------------------
    ipcMain.handle("system:cached", () => analyzer.getCached());
    ipcMain.handle("system:scan", async () => {
        const result = await analyzer.analyze();
        if (result.ok) settings.set({ lastScanAt: result.scannedAt });
        return result;
    });

    // --- tweaks ------------------------------------------------------------
    ipcMain.handle("tweaks:list", () =>
        engine.getTweaks().map((t) => ({
            id: t.id,
            name: t.name,
            category: t.category,
            risk: t.risk,
            description: t.description,
            detailedDescription: t.detailedDescription,
            recommended: t.recommended,
            requiresRestart: t.requiresRestart,
            requiresAdmin: t.requiresAdmin,
            undoable: t.undoable,
            warnings: t.warnings,
            windowsDefault: t.windowsDefault,
            unavailable: t.unavailable,
            // The exact registry values / services this tweak touches, shown in
            // the details dialog so nothing happens the user could not preview.
            affected: t.affected,
        }))
    );
    ipcMain.handle("tweaks:detect", (_e, ids) => engine.detect(Array.isArray(ids) ? ids : null));
    ipcMain.handle("tweaks:inspect", (_e, id) => engine.inspect(String(id)));

    ipcMain.handle("tweaks:apply", async (_e, ids) => {
        if (!Array.isArray(ids) || !ids.length) return { results: [], summary: null };
        const win = getWindow();
        return engine.applyTweaks(ids, {
            isAdmin: isAdmin(),
            onProgress: (p) => win && !win.isDestroyed() && win.webContents.send("tweaks:progress", p),
        });
    });

    // --- history / undo ----------------------------------------------------
    ipcMain.handle("history:list", () => engine.getHistory());
    ipcMain.handle("history:undo", (_e, entryId) =>
        engine.undoEntry(String(entryId), { isAdmin: isAdmin() })
    );

    // --- restore points ----------------------------------------------------
    ipcMain.handle("restore:status", () => restore.status());
    ipcMain.handle("restore:create", (_e, description) =>
        restore.create(typeof description === "string" && description.trim() ? description.trim() : "Panda Tweaks")
    );

    // A preset is a named list of tweak ids — no separate engine, the ids go
    // through the ordinary apply flow.
    ipcMain.handle("data:presets", () => readJson("presets.json", []));

    // --- autostart ---------------------------------------------------------
    ipcMain.handle("startup:list", () => engine.listStartup());
    ipcMain.handle("startup:set", async (_e, changes) => {
        if (!Array.isArray(changes) || !changes.length) return { results: [], summary: null };
        const win = getWindow();
        return engine.setStartup(
            changes.map((c) => ({ name: String(c.name), scope: String(c.scope), enabled: c.enabled === true })),
            { onProgress: (p) => win && !win.isDestroyed() && win.webContents.send("tweaks:progress", p) }
        );
    });

    // --- debloat -----------------------------------------------------------
    // The list is what the machine actually has; the catalogue only names it.
    ipcMain.handle("debloat:list", () => engine.listApps(readJson("debloat.json", [])));
    ipcMain.handle("debloat:remove", async (_e, packages) => {
        if (!Array.isArray(packages) || !packages.length) return { results: [], summary: null };
        const win = getWindow();
        return engine.removeApps(packages.map(String), {
            onProgress: (p) => win && !win.isDestroyed() && win.webContents.send("tweaks:progress", p),
        });
    });

    // --- logs --------------------------------------------------------------
    ipcMain.handle("log:read", () => logger.read());
    ipcMain.handle("log:clear", () => logger.clear());
    ipcMain.handle("log:export", async () => {
        const win = getWindow();
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: "Export log",
            defaultPath: `panda-tweaks-${new Date().toISOString().slice(0, 10)}.log`,
            filters: [{ name: "Log file", extensions: ["log", "txt"] }],
        });
        if (canceled || !filePath) return { ok: false, canceled: true };
        try {
            fs.writeFileSync(filePath, logger.read(), "utf8");
            return { ok: true, path: filePath };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
}

module.exports = { register };
