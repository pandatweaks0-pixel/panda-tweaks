"use strict";

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

const logger = require("./logger");
const settings = require("./settings");
const engine = require("./engine");
const analyzer = require("./analyzer");
const ipc = require("./ipc");

const DATA_DIR = path.join(__dirname, "..", "data");
const RENDERER = path.join(__dirname, "..", "renderer", "index.html");
const isDev = process.argv.includes("--dev");

let mainWindow = null;

// A second launch (for example the elevated relaunch) focuses the existing
// window instead of opening a duplicate.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    app.whenReady().then(start);
}

function start() {
    const userData = app.getPath("userData");

    logger.init(userData);
    logger.info("Panda Tweaks starting", {
        version: app.getVersion(),
        elevated: process.argv.includes("--elevated"),
    });

    settings.init(userData);
    engine.initHistory(userData);
    engine.initBlocked(userData);
    analyzer.init(userData);

    const load = engine.loadTweaks(DATA_DIR);
    if (!load.ok) logger.error("Starting without a tweak database", { error: load.error });

    ipc.register({ getWindow: () => mainWindow, dataDirectory: DATA_DIR });

    createWindow();
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 1040,
        minHeight: 680,
        show: false,
        backgroundColor: "#0d1117",
        frame: false,
        titleBarStyle: "hidden",
        icon: path.join(__dirname, "..", "renderer", "assets", "logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            // No remote content is ever loaded, so the renderer has no business
            // navigating anywhere.
            webviewTag: false,
        },
    });

    mainWindow.loadFile(RENDERER);
    mainWindow.once("ready-to-show", () => mainWindow.show());

    // Links go to the user's browser; the app window itself never navigates.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (url !== mainWindow.webContents.getURL()) {
            event.preventDefault();
            if (/^https:\/\//i.test(url)) shell.openExternal(url);
        }
    });

    mainWindow.on("closed", () => (mainWindow = null));

    if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
}

app.on("window-all-closed", () => app.quit());

// A crash in one handler should be logged, not swallowed silently.
process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception in main process", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in main process", { reason: String(reason) });
});
