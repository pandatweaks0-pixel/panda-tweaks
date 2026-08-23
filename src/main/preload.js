"use strict";

// The bridge. Every function here maps to one typed IPC channel — there is no
// generic "run a command" escape hatch, by design.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("panda", {
    window: {
        minimize: () => ipcRenderer.send("window:minimize"),
        maximize: () => ipcRenderer.send("window:maximize"),
        close: () => ipcRenderer.send("window:close"),
        isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    },

    app: {
        info: () => ipcRenderer.invoke("app:info"),
        requestAdmin: () => ipcRenderer.invoke("app:requestAdmin"),
        openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
        showItemInFolder: (which) => ipcRenderer.invoke("app:showItemInFolder", which),
    },

    settings: {
        get: () => ipcRenderer.invoke("settings:get"),
        set: (patch) => ipcRenderer.invoke("settings:set", patch),
        reset: () => ipcRenderer.invoke("settings:reset"),
    },

    i18n: {
        load: (lang) => ipcRenderer.invoke("i18n:load", lang),
    },

    system: {
        cached: () => ipcRenderer.invoke("system:cached"),
        scan: () => ipcRenderer.invoke("system:scan"),
    },

    tweaks: {
        list: () => ipcRenderer.invoke("tweaks:list"),
        detect: (ids) => ipcRenderer.invoke("tweaks:detect", ids),
        inspect: (id) => ipcRenderer.invoke("tweaks:inspect", id),
        apply: (ids) => ipcRenderer.invoke("tweaks:apply", ids),
        // Returns an unsubscribe function so views can clean up their listener.
        onProgress: (handler) => {
            const listener = (_event, payload) => handler(payload);
            ipcRenderer.on("tweaks:progress", listener);
            return () => ipcRenderer.removeListener("tweaks:progress", listener);
        },
    },

    history: {
        list: () => ipcRenderer.invoke("history:list"),
        undo: (entryId) => ipcRenderer.invoke("history:undo", entryId),
    },

    restore: {
        status: () => ipcRenderer.invoke("restore:status"),
        create: (description) => ipcRenderer.invoke("restore:create", description),
    },

    presets: () => ipcRenderer.invoke("data:presets"),

    startup: {
        list: () => ipcRenderer.invoke("startup:list"),
        set: (changes) => ipcRenderer.invoke("startup:set", changes),
    },

    debloat: {
        list: () => ipcRenderer.invoke("debloat:list"),
        remove: (packages) => ipcRenderer.invoke("debloat:remove", packages),
    },

    log: {
        read: () => ipcRenderer.invoke("log:read"),
        clear: () => ipcRenderer.invoke("log:clear"),
        export: () => ipcRenderer.invoke("log:export"),
    },
});
