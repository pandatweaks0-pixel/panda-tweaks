"use strict";

const State = {
    page: "dashboard",
    tweaks: [],
    detection: new Map(),
    history: [],
    scan: null,
    settings: {},
    appInfo: {},
    debloat: [],
    debloatInstalled: null,
    debloatRecommended: null,
    debloatError: null,
    debloatOpen: new Set(),
    cleanupScan: new Map(),
    startup: null,
    presets: null,
    selection: new Set(),
    appSelection: new Set(),
    filters: { risk: "all", category: "all", search: "" },
    busy: false,
};

// Grouped so the sidebar reads as three intents rather than one long list:
// see the state, change something, manage the app.
const NAV_GROUPS = [
    { label: null, items: [["dashboard", "dashboard"]] },
    {
        label: "nav.group.optimise",
        items: [
            ["recommended", "star"],
            ["tweaks", "sliders"],
            ["debloat", "broom"],
            ["fixes", "wrench"],
            ["presets", "gamepad"],
        ],
    },
    {
        label: "nav.group.system",
        items: [
            ["startup", "power"],
            ["services", "stack"],
            ["cleanup", "trash"],
            ["system", "chip"],
            ["history", "clock"],
        ],
    },
    {
        label: "nav.group.app",
        items: [
            ["settings", "gear"],
            ["about", "info"],
        ],
    },
];

const App = {
    // --- lifecycle -----------------------------------------------------------

    async init() {
        State.appInfo = await window.panda.app.info();
        State.settings = await window.panda.settings.get();

        await I18N.load(State.settings.language || navigator.language.slice(0, 2));
        this.applyTheme();
        this.bindChrome();

        State.tweaks = await window.panda.tweaks.list();
        State.presets = await window.panda.presets();
        State.history = await window.panda.history.list();
        State.scan = await window.panda.system.cached();
        this.indexDetection(State.scan?.detection);

        await this.loadDebloat();

        this.render();

        // Reveal the app before the wizard, so the first thing behind the
        // wizard card is the real dashboard rather than a blank window.
        Splash.hide();

        if (!State.settings.firstRunComplete) {
            await this.firstRun();
        }
        if (!State.scan) this.scan();
    },

    indexDetection(detection) {
        State.detection = new Map((detection || []).map((d) => [d.id, d]));
    },

    // The recommendations belong to a scan, and a scan is a snapshot from
    // minutes ago; detection is re-read after every apply. Filtering the
    // snapshot through the fresh reading is what makes a tweak leave the list
    // the moment it is applied - rescanning instead would be correct too, and
    // would cost eighteen seconds after every single apply.
    //
    // Unavailable is filtered for the same reason: a tweak Windows refused
    // permanently gets marked mid-session, and going on recommending it is
    // recommending something that cannot be done.
    liveRecommendations() {
        const recs = State.scan?.recommendations || [];
        if (!recs.length) return recs;
        const byId = new Map(State.tweaks.map((x) => [x.id, x]));
        return recs.filter((r) => {
            const tweak = byId.get(r.id);
            if (!tweak || tweak.unavailable) return false;
            const status = State.detection.get(r.id)?.status;
            return status !== "applied" && status !== "unavailable";
        });
    },

    async loadDebloat() {
        // The main process enumerates what is really installed and folds the
        // catalogue into it, so entries carry their exact package name already.
        const res = await window.panda.debloat.list();
        State.debloat = res.entries || [];
        State.debloatError = res.ok ? null : res.error;
        State.debloatInstalled = State.debloat.filter((d) => d.installed && !d.protected).length;
        // The badge and the dashboard count what the app actually suggests
        // removing. "46 removable apps" is a fact about Windows, not advice.
        State.debloatRecommended = State.debloat.filter((d) => d.installed && !d.protected && d.recommended).length;
    },

    bindChrome() {
        document.getElementById("btn-min").onclick = () => window.panda.window.minimize();
        document.getElementById("btn-max").onclick = () => window.panda.window.maximize();
        document.getElementById("btn-close").onclick = () => window.panda.window.close();

        const badge = document.getElementById("admin-badge");
        badge.textContent = State.appInfo.isAdmin ? t("admin.elevatedBadge") : t("admin.notElevated");
        badge.hidden = false;
    },

    // --- theming -------------------------------------------------------------

    applyTheme() {
        let theme = State.settings.theme || "dark";
        if (theme === "system") {
            theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
        }
        document.body.dataset.theme = theme;
        const accent = State.settings.accentColor || "#4ade80";
        document.documentElement.style.setProperty("--accent", accent);
        // Dark text on light accents, light text on dark ones, so the label on a
        // primary button stays readable whatever colour is chosen.
        document.documentElement.style.setProperty("--accent-ink", this.contrastInk(accent));
    },

    contrastInk(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex);
        if (!m) return "#04140a";
        const n = parseInt(m[1], 16);
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        // Rec. 601 luma is good enough to pick between two inks.
        return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#04140a" : "#ffffff";
    },

    // --- navigation ----------------------------------------------------------

    go(page) {
        State.page = page;
        this.render();
        document.getElementById("view").scrollTop = 0;
        // Sizes cost a directory walk, so they are read when the page is opened
        // rather than on every system scan.
        if (page === "cleanup") this.scanCleanup(false);
        if (page === "startup") this.loadStartup(false);
    },

    // --- autostart -----------------------------------------------------------

    async loadStartup(force) {
        if (State.startup !== null && !force) return;
        const res = await window.panda.startup.list();
        State.startup = res.entries || [];
        if (!res.ok) toast(res.error || t("startup.readFailed"), "bad");
        if (State.page === "startup") this.render();
    },

    async toggleStartup(entry) {
        const outcome = await window.panda.startup.set([
            { name: entry.name, scope: entry.scope, enabled: !entry.enabled },
        ]);
        const failed = outcome.results.filter((r) => !r.ok);
        if (failed.length) toast(failed[0].error || t("startup.changeFailed"), "bad");
        else toast(entry.enabled ? t("startup.turnedOff", { name: entry.name }) : t("startup.turnedOn", { name: entry.name }), "ok");
        State.history = await window.panda.history.list();
        await this.loadStartup(true);
    },

    // Fills in "how much would this actually free" per cleanup target. Each
    // inspect is the same capture the details dialog uses.
    async scanCleanup(force) {
        const targets = State.tweaks.filter((x) => x.category === "Cleanup");
        if (!targets.length) return;
        if (force) State.cleanupScan = new Map();
        const pending = targets.filter((x) => force || !State.cleanupScan.has(x.id));
        if (!pending.length) return;
        this.render();
        await Promise.all(
            pending.map(async (tweak) => {
                const detail = await window.panda.tweaks.inspect(tweak.id);
                State.cleanupScan.set(tweak.id, detail?.operations?.[0] || { now: null });
            })
        );
        if (State.page === "cleanup") this.render();
    },

    renderNav() {
        const counts = {
            recommended: this.liveRecommendations().length,
            debloat: State.debloatRecommended || 0,
        };
        const nav = document.getElementById("sidebar");
        mount(
            nav,
            ...NAV_GROUPS.flatMap((group) => [
                group.label ? h("div.navgroup", { text: t(group.label) }) : null,
                ...group.items.map(([page, iconName]) =>
                    h(
                        "button.navitem",
                        {
                            "aria-current": State.page === page ? "page" : null,
                            onclick: () => this.go(page),
                        },
                        h("span.navitem__icon", null, icon(iconName)),
                        t(`nav.${page}`),
                        counts[page] ? h("span.navitem__count", { text: String(counts[page]) }) : null
                    )
                ),
            ]).filter(Boolean),
            h(
                "div.sidebar__footer",
                null,
                State.appInfo.isAdmin
                    ? h("span", { text: t("admin.elevatedBadge") })
                    : h("button.btn.btn--sm.btn--ghost", {
                          text: t("admin.restartAsAdmin"),
                          onclick: () => this.requestAdmin(),
                      })
            )
        );
    },

    render() {
        this.renderNav();
        const view = document.getElementById("view");
        const renderer = Views[State.page] || Views.dashboard;
        try {
            mount(view, renderer());
        } catch (e) {
            // A view that throws used to abort the render and leave the previous
            // page on screen — the app looked like the click had simply been
            // ignored. Failing visibly beats failing silently.
            console.error(`View "${State.page}" failed to render`, e);
            mount(
                view,
                h(
                    "div.page",
                    null,
                    h("h1", { text: t("common.error") }),
                    h("div.notice.notice--bad.mt-4", { text: `${State.page}: ${e.message}` })
                )
            );
        }
    },

    // Re-renders just the tweak list, so typing in the search box does not steal
    // focus from the input on every keystroke.
    renderTweakList() {
        const container = document.getElementById("tweak-list");
        if (!container) return this.render();
        const fresh = Views.tweaks().querySelector("#tweak-list");
        mount(container, ...fresh.childNodes);
    },

    refreshSelection() {
        this.render();
    },

    clearSelection() {
        State.selection.clear();
        this.render();
    },

    selectAll(ids) {
        for (const id of ids) {
            const tweak = State.tweaks.find((x) => x.id === id);
            const status = State.detection.get(id)?.status;
            if (tweak && !tweak.unavailable && status !== "applied") State.selection.add(id);
        }
        this.render();
    },

    // --- scanning ------------------------------------------------------------

    async scan() {
        if (State.busy) return;
        State.busy = true;

        const body = h(
            "div.row",
            null,
            h("div.spinner"),
            h("div", null, h("div", { text: t("dashboard.scanning") }), h("div.faint.small.mt-1", { text: t("dashboard.scanningHint") }))
        );
        const pending = openModal({ title: t("dashboard.scanNow"), body, dismissible: false });

        const result = await window.panda.system.scan();

        // Close the progress dialog regardless of outcome.
        document.getElementById("modal-root").hidden = true;
        clear(document.getElementById("modal-root"));
        pending.catch(() => {});

        State.busy = false;

        if (!result.ok) {
            toast(result.error || t("error.scanFailed"), "bad");
            this.render();
            return;
        }

        State.scan = result;
        State.settings = await window.panda.settings.get();
        this.indexDetection(result.detection);
        await this.loadDebloat();
        this.render();
    },

    // --- applying ------------------------------------------------------------

    // Pass ids to run something that was never "selected" — a repair is a single
    // button press, but it still goes through the same confirmation, restore
    // point offer, progress and result dialog as anything else.
    async startApplyFlow(explicitIds = null) {
        const ids = explicitIds || [...State.selection];
        if (!ids.length) return;

        // Drop what cannot run before asking to run it. A preset is a fixed list
        // of ids, and some of them name tweaks this machine has marked
        // unavailable — applying those can only ever report a failure, so the
        // Fortnite preset finished with a dozen red lines that were nobody's
        // fault. Selections cannot contain one (the card is disabled), so this
        // only ever trims the explicit lists.
        const all = ids.map((id) => State.tweaks.find((x) => x.id === id)).filter(Boolean);
        const available = all.filter((x) => !x.unavailable);
        const unavailable = all.length - available.length;

        // A preset is a fixed list written months ago on someone else's machine,
        // so it gets checked against this one: no battery-draining tweaks on a
        // laptop, no prefetch change on a spinning disk. A hand-picked selection
        // is left alone — ticking a box is a deliberate choice, and every one of
        // these stays applicable that way.
        const unfitById = new Map((State.scan?.unfit || []).map((u) => [u.id, u]));
        const misfits = explicitIds ? available.filter((x) => unfitById.has(x.id)) : [];
        const fitting = available.filter((x) => !misfits.includes(x));

        // Without elevation these cannot succeed: the engine refuses them before
        // it touches anything, so running them produced a result dialog saying
        // "2 applied, 5 failed" with no reason given and nothing in the log -
        // the refusal happens before the first line is written. Held back here
        // instead, with the one button that actually fixes it.
        const blockedByAdmin = State.appInfo.isAdmin ? [] : fitting.filter((x) => x.requiresAdmin);
        const chosen = fitting.filter((x) => !blockedByAdmin.includes(x));

        if (!chosen.length) {
            if (blockedByAdmin.length) {
                // Nothing left at all, so the only useful thing is the offer.
                const go = await confirmModal({
                    title: t("admin.neededTitle"),
                    message: t("apply.allNeedAdmin", { count: blockedByAdmin.length }),
                    confirmLabel: t("admin.restartAsAdmin"),
                });
                if (go) await this.requestAdmin();
                return;
            }
            toast(t(all.length && !available.length ? "apply.noneAvailable" : "apply.noneFit"), "warn");
            return;
        }
        const counts = {
            safe: chosen.filter((x) => x.risk === "safe").length,
            advanced: chosen.filter((x) => x.risk === "advanced").length,
            risky: chosen.filter((x) => x.risk === "risky").length,
        };

        if (State.settings.confirmBeforeApply) {
            const body = h(
                "div",
                null,
                h("p", { text: t("apply.breakdown", counts) }),
                unavailable
                    ? h("div.notice.mt-3", { text: t("apply.unavailableTrimmed", { count: unavailable }) })
                    : null,
                // Named one by one rather than counted. "3 left out" invites the
                // question this already answers.
                misfits.length
                    ? h(
                          "div.notice.notice--warn.mt-3",
                          null,
                          h("b", { text: t("apply.unfitTrimmed", { count: misfits.length }) }),
                          ...misfits.map((x) =>
                              h("div.small.mt-1", { text: `${x.name} — ${t(unfitById.get(x.id).reason)}` })
                          )
                      )
                    : null,
                counts.risky ? h("div.notice.notice--bad.mt-4", { text: t("apply.riskyWarning") }) : null,
                blockedByAdmin.length
                    ? h(
                          "div.notice.notice--warn.mt-3",
                          null,
                          h("b", { text: t("apply.adminTrimmed", { count: blockedByAdmin.length }) }),
                          ...blockedByAdmin.map((x) => h("div.small.mt-1", { text: x.name })),
                          h("button.btn.btn--sm.mt-2", {
                              text: t("admin.restartAsAdmin"),
                              onclick: () => this.requestAdmin(),
                          })
                      )
                    : null,
                h("div.notice.mt-3", { text: t("apply.restoreRecommended") }),
                h(
                    "div.mt-4",
                    null,
                    h("h3", { text: t("tweaks.whatItChanges") }),
                    h("div.list--tight.mt-2", null, ...chosen.map((x) => h("div.code", { text: x.name })))
                )
            );

            const choice = await openModal({
                title: t("apply.title", { count: chosen.length }),
                body,
                wide: true,
                buttons: [
                    { label: t("common.cancel"), value: "cancel" },
                    { label: t("apply.createRestore"), value: "restore" },
                    { label: t("apply.applyNow"), variant: "primary", value: "apply" },
                ],
            });

            if (choice === null || choice === "cancel") return;
            if (choice === "restore") {
                const created = await this.createRestorePoint();
                if (!created) return; // the dialog already explained why
            }
        }

        // chosen, not ids: the unavailable ones were trimmed above, and handing
        // them to the engine anyway would put back the failures this removed.
        await this.runApply(chosen.map((x) => x.id));
    },

    async runApply(ids) {
        State.busy = true;

        const label = h("div", { text: t("apply.progress", { current: 1, total: ids.length }) });
        const fill = h("div.progress__fill");
        fill.style.width = "0%";
        const currentName = h("div.faint.small.mt-2");

        const unsubscribe = window.panda.tweaks.onProgress((p) => {
            label.textContent = t("apply.progress", { current: p.index + 1, total: p.total });
            fill.style.width = `${Math.round((p.index / p.total) * 100)}%`;
            currentName.textContent = p.name;
        });

        openModal({
            title: t("common.apply"),
            body: h("div", null, label, h("div.progress.mt-3", null, fill), currentName),
            dismissible: false,
        }).catch(() => {});

        const outcome = await window.panda.tweaks.apply(ids);
        unsubscribe();

        document.getElementById("modal-root").hidden = true;
        clear(document.getElementById("modal-root"));
        State.busy = false;

        await this.afterApply(outcome);
    },

    async afterApply(outcome) {
        const s = outcome.summary;
        State.selection.clear();
        State.history = await window.panda.history.list();
        this.indexDetection(await window.panda.tweaks.detect(null));

        const failures = outcome.results.filter((r) => r.status === "failed");

        const body = h(
            "div",
            null,
            h("p", { text: t("apply.done", { count: s.total }) }),
            h(
                "div.list--tight.mt-3",
                null,
                h("div.notice.notice--ok", { text: `✓ ${t("apply.successCount", { count: s.applied })}` }),
                s.partial ? h("div.notice.notice--warn", { text: `⚠ ${t("apply.partialCount", { count: s.partial })}` }) : null,
                s.failed ? h("div.notice.notice--bad", { text: `✕ ${t("apply.failedCount", { count: s.failed })}` }) : null
            ),
            s.restartRequired ? h("div.notice.notice--warn.mt-3", { text: t("apply.restartNeeded") }) : null,
            failures.length
                ? h(
                      "div.mt-4",
                      null,
                      ...failures.map((f) => {
                          const tweak = State.tweaks.find((x) => x.id === f.tweakId);
                          const reason = f.error === "needs-admin" ? t("error.needsAdmin") : f.error || t("error.generic");
                          return h("div.code", { text: `${tweak ? tweak.name : f.tweakId} — ${reason}` });
                      })
                  )
                : null
        );

        const choice = await openModal({
            title: t("apply.done", { count: s.total }),
            body,
            wide: true,
            buttons: [
                { label: t("apply.viewInHistory"), value: "history" },
                { spacer: true },
                { label: t("common.close"), variant: "primary", value: "close" },
            ],
        });

        if (choice === "history") this.go("history");
        else this.render();
    },

    // --- undo ----------------------------------------------------------------

    async undo(entry) {
        const confirmed = await confirmModal({
            title: entry.tweakName,
            message: t("history.undoConfirm"),
            confirmLabel: t("common.undo"),
        });
        if (!confirmed) return;

        const result = await window.panda.history.undo(entry.id);
        if (result.ok) {
            toast(t("history.undoSuccess"), "ok");
        } else if (result.error === "needs-admin") {
            toast(t("error.needsAdmin"), "warn");
        } else {
            toast(result.error || t("history.undoFailed"), "bad");
        }

        State.history = await window.panda.history.list();
        this.indexDetection(await window.panda.tweaks.detect(null));
        this.render();
    },

    // --- debloat -------------------------------------------------------------

    async removeSelectedApps() {
        const chosen = State.debloat.filter((d) => State.appSelection.has(d.package) && d.installed && !d.protected);
        const names = chosen.flatMap((d) => d.resolved);
        if (!names.length) return;

        const keep = chosen.filter((d) => d.keep);

        const confirmed = await openModal({
            title: t("common.remove"),
            body: h(
                "div",
                null,
                h("div.notice.notice--warn", { text: t("debloat.notReversibleWarning") }),
                // Named, not just identified. A list of package ids is a list
                // nobody can check, and an unchecked list is how the Snipping
                // Tool left this machine.
                keep.length
                    ? h("div.notice.notice--bad.mt-3", { text: t("debloat.keepWarning", { names: keep.map((d) => d.name).join(", ") }) })
                    : null,
                h(
                    "div.list--tight.mt-4",
                    null,
                    ...chosen.map((d) =>
                        h(
                            "div.change",
                            null,
                            h("div.tweak__name", null, d.name, d.keep ? h("span.badge.badge--warn", { text: t("debloat.keep") }) : null),
                            h("div.change__target", { text: d.resolved.join(", ") })
                        )
                    )
                )
            ),
            buttons: [
                { label: t("common.cancel"), value: false },
                { label: t("common.remove"), variant: "danger", value: true },
            ],
        });
        if (!confirmed) return;

        const outcome = await window.panda.debloat.remove(names);
        State.appSelection.clear();
        State.history = await window.panda.history.list();
        await this.loadDebloat();

        const s = outcome.summary;
        toast(
            s.failed ? `${s.removed} removed, ${s.failed} failed` : `${s.removed} removed`,
            s.failed ? "warn" : "ok"
        );
        this.render();
    },

    // --- restore points ------------------------------------------------------

    // Returns true only when Windows confirmed a new restore point exists.
    async createRestorePoint() {
        openModal({
            title: t("restore.title"),
            body: h("div.row", null, h("div.spinner"), h("span", { text: t("restore.creating") })),
            dismissible: false,
        }).catch(() => {});

        const result = await window.panda.restore.create("Panda Tweaks");

        document.getElementById("modal-root").hidden = true;
        clear(document.getElementById("modal-root"));

        if (result.created) {
            toast(t("restore.created"), "ok");
            return true;
        }

        const messageKey = {
            "needs-admin": "restore.needsAdmin",
            throttled: "restore.throttled",
            "protection-disabled": "restore.protectionDisabled",
        }[result.reason] || "restore.error";

        // Never claim success: explain what happened and let the user decide.
        const choice = await openModal({
            title: t("restore.title"),
            body: h(
                "div",
                null,
                h("div.notice.notice--warn", { text: t(messageKey) }),
                result.message ? h("div.code.mt-3", { text: result.message }) : null
            ),
            buttons: [
                { label: t("common.cancel"), value: false },
                { label: t("restore.continue"), variant: "primary", value: true },
            ],
        });
        return choice === true;
    },

    async maybeAskForRestorePoint() {
        if (!State.settings.askForRestorePoint) return;
        const choice = await openModal({
            title: t("restore.title"),
            body: h("div", null, h("p", { text: t("restore.body") }), h("p.faint.small.mt-3", { text: t("restore.dontAskHint") })),
            dismissible: false,
            buttons: [
                { label: t("restore.dontAsk"), value: "never" },
                { spacer: true },
                { label: t("restore.continue"), value: "skip" },
                { label: t("restore.create"), variant: "primary", value: "create" },
            ],
        });

        if (choice === "never") await this.updateSettings({ askForRestorePoint: false }, false);
        else if (choice === "create") await this.createRestorePoint();
    },

    // --- first run -----------------------------------------------------------

    // Three-step setup shown once: language, appearance, restore point. Each
    // choice applies immediately so the wizard itself previews the result.
    firstRun() {
        return new Promise((resolve) => {
            const root = document.getElementById("modal-root");
            let step = 0;

            const finish = async () => {
                await this.updateSettings({ firstRunComplete: true }, false);
                root.hidden = true;
                clear(root);
                resolve();
            };

            const dots = () =>
                h(
                    "div.wiz__dots",
                    null,
                    ...[0, 1, 2].map((i) => h(`div.wiz__dot${i === step ? ".wiz__dot--active" : ""}`))
                );

            const choice = (label, description, onClick, { pressed = false, big = false } = {}) =>
                h(
                    `button.wiz__choice${big ? ".wiz__choice--big" : ""}`,
                    { onclick: onClick, "aria-pressed": String(pressed) },
                    h("span.wiz__t", { text: label }),
                    description ? h("span.wiz__d", { text: description }) : null
                );

            const steps = [
                // 1 — language
                () =>
                    h(
                        "div.wiz",
                        null,
                        h("img.wiz__logo", { src: "assets/logo.png", alt: "" }),
                        h("h2", { text: t("firstrun.welcome") }),
                        h("p", { text: t("firstrun.langText") }),
                        h(
                            "div.wiz__choices",
                            null,
                            ...[
                                ["en", "English"],
                                ["de", "Deutsch"],
                            ].map(([code, label]) =>
                                choice(
                                    label,
                                    null,
                                    async () => {
                                        await this.setLanguage(code, false);
                                        next();
                                    },
                                    { pressed: I18N.lang === code }
                                )
                            )
                        ),
                        dots()
                    ),

                // 2 — appearance
                () =>
                    h(
                        "div.wiz",
                        null,
                        h("div.wiz__icon", { text: "🎨" }),
                        h("h2", { text: t("firstrun.chooseTheme") }),
                        h("p", { text: t("firstrun.themeText") }),
                        h(
                            "div.wiz__choices.wiz__choices--vertical",
                            null,
                            ...["dark", "midnight", "light", "minimal"].map((theme) =>
                                choice(
                                    t(`settings.theme.${theme}`),
                                    null,
                                    async () => {
                                        await this.updateSettings({ theme }, false);
                                        next();
                                    },
                                    { pressed: State.settings.theme === theme, big: true }
                                )
                            )
                        ),
                        dots()
                    ),

                // 3 — restore point
                () => {
                    const status = h("div.wiz__status");
                    const never = h("input", { type: "checkbox" });
                    return h(
                        "div.wiz",
                        null,
                        h("div.wiz__icon", { text: "🛡️" }),
                        h("h2", { text: t("firstrun.rpTitle") }),
                        h("p", { text: t("firstrun.rpText") }),
                        h(
                            "div.wiz__choices.wiz__choices--vertical",
                            null,
                            choice(
                                t("firstrun.rpYes"),
                                t("firstrun.rpYesD"),
                                async (e) => {
                                    e.currentTarget.disabled = true;
                                    status.textContent = t("restore.creating");
                                    const result = await window.panda.restore.create("Panda Tweaks");
                                    if (result.created) {
                                        status.textContent = t("restore.created");
                                        setTimeout(done, 900);
                                    } else {
                                        // Never claim it worked — say what happened
                                        // and let the user carry on.
                                        status.style.color = "var(--warn)";
                                        status.textContent = t(
                                            {
                                                "needs-admin": "restore.needsAdmin",
                                                throttled: "restore.throttled",
                                                "protection-disabled": "restore.protectionDisabled",
                                            }[result.reason] || "restore.error"
                                        );
                                        e.currentTarget.disabled = false;
                                    }
                                },
                                { big: true }
                            ),
                            choice(t("firstrun.rpNo"), null, () => done(), { big: true })
                        ),
                        status,
                        h(
                            "label.row.small.faint.mt-4",
                            { style: { justifyContent: "center", cursor: "pointer" } },
                            never,
                            h("span", { text: t("firstrun.never") })
                        ),
                        dots()
                    );

                    async function done() {
                        if (never.checked) await App.updateSettings({ askForRestorePoint: false }, false);
                        finish();
                    }
                },
            ];

            const draw = () => {
                mount(root, steps[step]());
                root.hidden = false;
            };
            const next = () => {
                step++;
                step < steps.length ? draw() : finish();
            };

            draw();
        });
    },

    // --- settings ------------------------------------------------------------

    async updateSettings(patch, rerender = true) {
        State.settings = await window.panda.settings.set(patch);
        this.applyTheme();
        if (rerender) this.render();
    },

    async setLanguage(lang, rerender = true) {
        await I18N.load(lang);
        State.settings = await window.panda.settings.set({ language: lang });
        this.bindChrome();
        if (rerender) this.render();
    },

    async resetSettings() {
        const confirmed = await confirmModal({
            title: t("settings.resetSettings"),
            message: t("settings.resetConfirm"),
            confirmLabel: t("settings.resetSettings"),
            variant: "danger",
        });
        if (!confirmed) return;
        State.settings = await window.panda.settings.reset();
        await I18N.load(State.settings.language || "en");
        this.applyTheme();
        this.bindChrome();
        this.render();
    },

    async requestAdmin() {
        // The UAC prompt is answered by a person, so this waits. Saying that up
        // front beats a button that looks broken for as long as the dialog is up.
        toast(t("admin.waiting"), "ok");
        const result = await window.panda.app.requestAdmin();
        if (result.ok) return; // this window is about to be replaced by the elevated one
        toast(result.cancelled ? t("admin.declined") : result.error || t("error.generic"), result.cancelled ? "warn" : "bad");
    },

    async exportLog() {
        const result = await window.panda.log.export();
        if (result.ok) toast(result.path, "ok");
        else if (!result.canceled) toast(result.error || t("error.generic"), "bad");
    },

    async clearLog() {
        await window.panda.log.clear();
        toast(t("settings.clearLog"), "ok");
    },
};

window.addEventListener("DOMContentLoaded", () => {
    App.init().catch((err) => {
        // A failure this early has no UI to report into yet, so it goes straight
        // onto the page rather than vanishing into the console.
        document.getElementById("view").textContent = `Startup failed: ${err.message}`;
        console.error(err);
    });
});
