"use strict";

// Local, append-only log. Records what was changed and what the value was
// before and after — never anything identifying about the user, and never
// anything leaves the machine.

const fs = require("fs");
const path = require("path");

let logFile = null;
const MAX_BYTES = 4 * 1024 * 1024;

function init(userDataDir) {
    logFile = path.join(userDataDir, "panda-tweaks.log");
    rotateIfNeeded();
}

function rotateIfNeeded() {
    if (!logFile) return;
    try {
        if (fs.statSync(logFile).size > MAX_BYTES) {
            fs.renameSync(logFile, logFile + ".1");
        }
    } catch {
        /* no log yet */
    }
}

function write(level, message, detail) {
    const line =
        `[${new Date().toISOString()}] [${level}] ${message}` +
        (detail !== undefined ? ` ${JSON.stringify(detail)}` : "");
    if (!logFile) {
        // Before init (very early startup) the console is the only sink.
        console.log(line);
        return;
    }
    try {
        fs.appendFileSync(logFile, line + "\n", "utf8");
    } catch {
        /* logging must never break the action it is logging */
    }
}

const info = (m, d) => write("INFO", m, d);
const warn = (m, d) => write("WARN", m, d);
const error = (m, d) => write("ERROR", m, d);

function read() {
    if (!logFile) return "";
    try {
        return fs.readFileSync(logFile, "utf8");
    } catch {
        return "";
    }
}

function clear() {
    if (!logFile) return false;
    try {
        fs.writeFileSync(logFile, "", "utf8");
        return true;
    } catch {
        return false;
    }
}

const getPath = () => logFile;

module.exports = { init, info, warn, error, read, clear, getPath };
