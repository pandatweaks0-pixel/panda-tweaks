"use strict";

// Localization. Every visible string comes from a locale file; nothing in the
// views is hardcoded English.

const I18N = {
    lang: "en",
    strings: {},

    async load(lang) {
        const res = await window.panda.i18n.load(lang);
        this.lang = res.lang;
        this.strings = res.strings || {};
        document.documentElement.lang = this.lang;
        return res.ok;
    },

    // Missing keys render as the key itself rather than an empty string, so a
    // gap is obvious instead of silently invisible.
    t(key, params) {
        let value = this.strings[key];
        if (value === undefined) return key;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                value = value.replaceAll(`{${k}}`, String(v));
            }
        }
        return value;
    },

    has(key) {
        return this.strings[key] !== undefined;
    },

    // Locale-aware formatting for the few places that show dates and numbers.
    date(iso) {
        if (!iso) return this.t("common.never");
        try {
            return new Date(iso).toLocaleString(this.lang === "de" ? "de-DE" : "en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
            });
        } catch {
            return String(iso);
        }
    },

    relativeDay(iso) {
        if (!iso) return this.t("common.never");
        const d = new Date(iso);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        const time = d.toLocaleTimeString(this.lang === "de" ? "de-DE" : "en-GB", {
            hour: "2-digit",
            minute: "2-digit",
        });
        if (sameDay) return `${this.lang === "de" ? "Heute" : "Today"}, ${time}`;
        return this.date(iso);
    },

    bytes(n) {
        if (typeof n !== "number" || Number.isNaN(n)) return "—";
        const units = ["B", "KB", "MB", "GB", "TB"];
        let i = 0;
        let v = n;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i++;
        }
        return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
    },
};

const t = (key, params) => I18N.t(key, params);
