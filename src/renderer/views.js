"use strict";

// Page renderers. Each returns a DOM node; App owns navigation and state.

const Views = {};

// --- shared pieces -----------------------------------------------------------

function pageHead(title, subtitle, ...actions) {
    return h(
        "div.page__head.row.row--between.row--wrap",
        null,
        h("div", null, h("h1", { text: title }), subtitle ? h("p.page__sub", { text: subtitle }) : null),
        actions.length ? h("div.row", null, ...actions) : null
    );
}

function scoreRow(key, result) {
    const tone = scoreTone(result.score);
    return h(
        "button.scorerow",
        {
            onclick: () => Views.showScoreBreakdown(key, result),
            title: t("score.measured", { measured: result.measured, total: result.total }),
        },
        h("span.scorerow__label", { text: t(`score.${key}`) }),
        meter(result.score, tone),
        h(
            "span.scorerow__num",
            null,
            result.score === null ? "—" : String(result.score),
            result.score === null ? null : h("small", { text: "/100" })
        )
    );
}

function fact(label, value) {
    if (value === null || value === undefined || value === "") return null;
    return h("div.fact", null, h("span.fact__k", { text: label }), h("span.fact__v", { text: String(value) }));
}

Views.showScoreBreakdown = (key, result) =>
    openModal({
        title: t(`score.${key}`),
        subtitle: t("score.explain"),
        wide: true,
        body: h(
            "div",
            null,
            h(
                "div.row.mt-1",
                null,
                h("span.score__value", { text: result.score === null ? "—" : String(result.score) }),
                h("div.spacer"),
                h("span.faint.small", { text: t("score.measured", { measured: result.measured, total: result.total }) })
            ),
            meter(result.score, scoreTone(result.score)),
            h(
                "div.mt-5",
                null,
                ...result.checks.map((c) =>
                    h(
                        "div.checkline",
                        null,
                        h(`span.dot.dot--${c.status}`, { style: { marginTop: "7px" } }),
                        h(
                            "div.checkline__label",
                            null,
                            h("div", { text: c.label }),
                            h("div.checkline__detail", { text: c.detail ?? t("score.unknown") })
                        ),
                        h("span.checkline__weight", { text: t("score.weight", { n: c.weight }) })
                    )
                )
            )
        ),
        buttons: [{ label: t("common.close") }],
    });

// --- tweak card --------------------------------------------------------------

function tweakCard(tweak, { reason = null } = {}) {
    const state = State.detection.get(tweak.id);
    const status = tweak.unavailable ? "unavailable" : state?.status || "unknown";
    const selectable = !tweak.unavailable && status !== "applied";
    const selected = State.selection.has(tweak.id);

    const checkbox = h("input.check", {
        type: "checkbox",
        checked: selected,
        disabled: !selectable,
        "aria-label": tweak.name,
        onchange: (e) => {
            e.target.checked ? State.selection.add(tweak.id) : State.selection.delete(tweak.id);
            App.refreshSelection();
        },
    });

    // Only the exceptions are worth a line. Risk already has its own badge, and
    // "reversible, no restart" is the norm — repeating it on every card was
    // noise that pushed the list to five visible items.
    // The risk badge leads this row rather than trailing the title: on a card it
    // belongs on the footer line with the other qualifiers, where the eye lands
    // after reading the description and before reaching for the switch.
    const flags = [
        riskBadge(tweak.risk, { quiet: true }),
        tweak.requiresRestart ? h("span.flag", { text: t("tweaks.restart") }) : null,
        tweak.requiresAdmin ? h("span.flag", { text: t("tweaks.needsAdmin") }) : null,
        !tweak.undoable && !tweak.unavailable ? h("span.flag.flag--warn", { text: t("tweaks.notReversible") }) : null,
    ].filter(Boolean);

    return h(
        `div.tweak${selected ? ".tweak--selected" : ""}${tweak.unavailable ? ".tweak--disabled" : ""}`,
        { dataset: { tweakId: tweak.id } },
        checkbox,
        h(
            "div.tweak__body",
            null,
            h("div.tweak__name", null, tweak.name, statusBadge(status)),
            h("p.tweak__desc", { text: tweak.description }),
            reason ? h("p.small.mt-2", null, h("b", { text: `${t("recommended.reason")}: ` }), t(reason)) : null,
            tweak.unavailable
                ? h("div.notice.notice--warn.mt-2", null, `${t("tweaks.unavailableReason")}: ${tweak.unavailable}`)
                : null,
            flags.length ? h("div.tweak__meta", null, ...flags) : null
        ),
        h(
            "div.tweak__actions",
            null,
            h("button.btn.btn--sm", { text: t("common.details"), onclick: () => Views.showTweakDetails(tweak) })
        )
    );
}

// One row of the change table: what is touched, what it holds now, what it
// would hold afterwards. The "now" column is read live when the dialog opens.
function changeRow(op) {
    const unchanged = op.applied === true;
    return h(
        "div.change",
        null,
        h(
            "div.change__head",
            null,
            h("span.change__kind", { text: op.kind }),
            op.type ? h("span.change__type", { text: op.type }) : null,
            unchanged ? h("span.badge.badge--safe", { text: t("status.applied") }) : null
        ),
        h("div.change__target", { text: op.target }),
        h(
            "div.change__values",
            null,
            h(
                "div.change__col",
                null,
                h("span.change__label", { text: t("tweaks.currentValue") }),
                h(`span.change__val${op.now === null ? ".faint" : ""}`, { text: op.now === null ? t("common.unknown") : op.now })
            ),
            h("span.change__arrow", { text: "→" }),
            h(
                "div.change__col",
                null,
                h("span.change__label", { text: t("tweaks.newValue") }),
                h(`span.change__val${unchanged ? "" : ".change__val--new"}`, { text: op.after })
            )
        )
    );
}

function factRow(label, value, tone) {
    return h(
        "div.checkline",
        null,
        h("span.checkline__label", { text: label }),
        h(`span${tone ? `.${tone}` : ""}`, { text: value })
    );
}

Views.showTweakDetails = async (tweak) => {
    const state = State.detection.get(tweak.id);
    const status = tweak.unavailable ? "unavailable" : state?.status || "unknown";
    const selectable = !tweak.unavailable && status !== "applied";

    const changeBox = h("div.mt-2", null, h("div.row", null, h("div.spinner"), h("span.faint.small", { text: t("common.loading") })));

    const pending = openModal({
        title: tweak.name,
        wide: true,
        body: h(
            "div",
            null,
            h(
                "div.row.row--wrap",
                null,
                riskBadge(tweak.risk),
                statusBadge(status),
                h("span.badge.badge--muted", { text: t(`category.${tweak.category}`) })
            ),
            h("p.mt-4", { text: tweak.detailedDescription || tweak.description }),
            h("p.small.faint.mt-2", { text: t(`risk.${tweak.risk}.help`) }),

            tweak.warnings.length
                ? h("div.mt-4", null, ...tweak.warnings.map((w) => h("div.notice.notice--bad", { text: w })))
                : null,

            tweak.unavailable
                ? h("div.notice.notice--warn.mt-4", { text: `${t("tweaks.unavailableReason")}: ${tweak.unavailable}` })
                : null,

            h("h3.mt-5", { text: t("tweaks.whatItChanges") }),
            changeBox,

            h(
                "div.mt-5",
                null,
                factRow(t("tweaks.restart"), tweak.requiresRestart ? t("common.yes") : t("common.no")),
                factRow(t("tweaks.needsAdmin"), tweak.requiresAdmin ? t("common.yes") : t("common.no")),
                factRow(
                    t("common.undo"),
                    tweak.undoable ? t("tweaks.reversible") : t("tweaks.notReversible"),
                    tweak.undoable ? null : "faint"
                )
            )
        ),
        buttons: [
            { label: t("common.close"), value: "close" },
            selectable
                ? { label: t("common.apply"), variant: "primary", value: "apply" }
                : null,
        ].filter(Boolean),
    });

    // Fill the change table once the live read comes back, so the dialog opens
    // immediately instead of waiting on PowerShell.
    window.panda.tweaks
        .inspect(tweak.id)
        .then((result) => {
            if (!result) return;
            mount(changeBox, ...result.operations.map(changeRow));
        })
        .catch(() => {
            mount(changeBox, h("div.notice.notice--warn", { text: t("error.generic") }));
        });

    const choice = await pending;
    if (choice === "apply") {
        State.selection.add(tweak.id);
        App.startApplyFlow();
    }
};

// --- selection bar -----------------------------------------------------------

function selectionBar() {
    const count = State.selection.size;
    if (!count) return null;
    return h(
        "div.card.row.row--between.row--wrap.mt-5",
        { id: "selection-bar" },
        h("strong", { text: t("common.selected", { n: count }) }),
        h(
            "div.row",
            null,
            h("button.btn.btn--ghost", { text: t("common.clearSelection"), onclick: () => App.clearSelection() }),
            h("button.btn.btn--primary", { text: t("common.applySelected"), onclick: () => App.startApplyFlow() })
        )
    );
}

// --- dashboard ---------------------------------------------------------------

function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return t("greeting.morning");
    if (hour < 18) return t("greeting.afternoon");
    return t("greeting.evening");
}

// A preview card: heading, count, the first few real entries, and a way through
// to the full page. Showing the actual names beats showing only a number.
function previewCard({ title, count, items, empty, onOpen }) {
    return h(
        "div.card.card--flush.preview",
        null,
        h(
            "div.preview__head",
            null,
            h("span.score__label", { text: title }),
            h("span.preview__count", { text: count === null ? "—" : String(count) })
        ),
        items.length
            ? h("div", null, ...items)
            : h("div.preview__empty", { text: empty }),
        h(
            "div.preview__foot",
            null,
            h("button.btn.btn--sm", { text: t("dashboard.viewAll"), onclick: onOpen })
        )
    );
}

Views.dashboard = () => {
    const scan = State.scan;

    if (!scan) {
        return h(
            "div.page",
            null,
            pageHead(greeting(), t("dashboard.neverScanned")),
            h(
                "div.card",
                null,
                h("p.muted", { text: t("dashboard.scanningHint") }),
                h("button.btn.btn--primary.mt-4", { text: t("dashboard.scanNow"), onclick: () => App.scan() })
            )
        );
    }

    const scores = scan.scores;
    const a = scan.analysis;
    const gpu = a.gpus?.[0];
    const drive = (a.drives || []).find((d) => /^C:/i.test(d.letter)) || (a.drives || [])[0];
    const byId = new Map(State.tweaks.map((x) => [x.id, x]));

    const liveRecs = App.liveRecommendations();
    const recommendedItems = liveRecs.slice(0, 5).map((r) => {
        const tweak = byId.get(r.id);
        return h(
            "div.preview__item",
            null,
            h(`span.dot.dot--${tweak?.risk === "safe" ? "good" : "fair"}`),
            h("span", { text: tweak ? tweak.name : r.id })
        );
    });

    const debloatItems = State.debloat
        .filter((d) => d.installed && !d.protected && d.recommended)
        .slice(0, 5)
        .map((d) => h("div.preview__item", null, h("span.dot.dot--fair"), h("span", { text: d.name })));

    return h(
        "div.page",
        null,
        pageHead(
            greeting(),
            `${t("dashboard.ready")} · ${t("dashboard.lastScan")}: ${I18N.relativeDay(scan.scannedAt)}`,
            h("button.btn", { text: t("dashboard.scanAgain"), onclick: () => App.scan() })
        ),

        h(
            "div.card.card--hero",
            null,
            h(
                "div.health",
                null,
                h(
                    "div.health__ring",
                    null,
                    ring(scores.overall, 148),
                    h(
                        "div.health__center",
                        null,
                        h("div.health__big", { text: scores.overall === null ? "—" : `${scores.overall}%` }),
                        h("div.health__cap", { text: t("dashboard.systemHealth") })
                    )
                ),
                h(
                    "div",
                    null,
                    ...["performance", "privacy", "debloat", "gaming", "security"].map((k) => scoreRow(k, scores[k]))
                )
            )
        ),

        h(
            "div.card.card--flush.facts.mt-4",
            null,
            fact(t("system.windows"), a.windows?.caption?.replace("Microsoft ", "")),
            fact(t("system.build"), a.windows?.build ? `${a.windows.build} · ${a.windows.displayVer ?? ""}`.trim() : null),
            fact(t("system.cpu"), a.cpu?.name?.replace(/\s+\d+-Core Processor/i, "")),
            fact(t("system.gpu"), gpu?.name),
            fact(t("system.ram"), a.ram?.totalGB ? `${a.ram.totalGB} GB · ${a.ram.configuredMHz} MHz` : null),
            fact(t("system.storage"), drive ? `${drive.freeGB} / ${drive.totalGB} GB` : null),
            fact(t("system.powerPlan"), a.powerPlan?.name)
        ),

        h(
            "div.grid.grid--2.mt-4",
            null,
            previewCard({
                title: t("dashboard.recommendedTweaks"),
                count: liveRecs.length,
                items: recommendedItems,
                empty: t("dashboard.noRecommendations"),
                onOpen: () => App.go("recommended"),
            }),
            previewCard({
                title: t("dashboard.debloatComponents"),
                count: State.debloatRecommended,
                items: debloatItems,
                empty: t("debloat.noneRecommended"),
                onOpen: () => App.go("debloat"),
            })
        )
    );
};

// --- recommended -------------------------------------------------------------

// What the analysis decided against, and why. Only the deliberate exclusions
// appear here — risky, and anything that would keep a laptop's hardware awake.
// A tweak that is simply already applied is not a decision worth explaining.
function skippedPanel() {
    const skipped = State.scan?.skipped || [];
    if (!skipped.length) return null;
    return h(
        "div.card.mt-4",
        null,
        h("h3", { text: t("skipped.title") }),
        h("p.faint.small", { text: t("skipped.subtitle") }),
        h(
            "div.list--tight.mt-3",
            null,
            ...skipped.map((s) => h("div", null, h("b", { text: s.name }), h("div.faint.small", { text: t(s.reason) })))
        )
    );
}

Views.recommended = () => {
    const scan = State.scan;
    const recs = scan ? App.liveRecommendations() : [];

    if (!recs.length) {
        return h(
            "div.page",
            null,
            pageHead(t("recommended.title"), t("recommended.subtitle")),
            h("div.empty", { text: scan ? t("recommended.empty") : t("dashboard.neverScanned") }),
            // Still worth showing with an empty list: "nothing to suggest" reads
            // very differently once you can see what was held back and why.
            skippedPanel()
        );
    }

    const byId = new Map(State.tweaks.map((x) => [x.id, x]));
    return h(
        "div.page",
        null,
        pageHead(
            t("recommended.title"),
            t("recommended.subtitle"),
            h("button.btn", {
                text: t("common.selectRecommended"),
                onclick: () => App.selectAll(recs.map((r) => r.id)),
            })
        ),
        h("div.list", null, ...recs.map((r) => tweakCard(byId.get(r.id), { reason: r.reason })).filter(Boolean)),
        skippedPanel(),
        selectionBar()
    );
};

// --- all tweaks --------------------------------------------------------------

Views.tweaks = () => {
    const f = State.filters;
    const showRisky = State.settings.showRiskyTweaks;

    let list = State.tweaks;
    if (!showRisky) list = list.filter((x) => x.risk !== "risky");
    if (f.risk !== "all") list = list.filter((x) => x.risk === f.risk);
    if (f.category !== "all") list = list.filter((x) => x.category === f.category);
    if (f.search) {
        const q = f.search.toLowerCase();
        list = list.filter((x) => x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q));
    }

    const categories = [...new Set(State.tweaks.map((x) => x.category))].sort();

    const riskChips = h(
        "div.chips",
        null,
        ...["all", "safe", "advanced", "risky"].map((r) =>
            h("button.chip", {
                text: r === "all" ? t("common.all") : t(`risk.${r}`),
                "aria-pressed": String(f.risk === r),
                onclick: () => {
                    f.risk = r;
                    App.render();
                },
            })
        )
    );

    const categorySelect = h(
        "select.select",
        {
            "aria-label": t("tweaks.filterCategory"),
            onchange: (e) => {
                f.category = e.target.value;
                App.render();
            },
        },
        h("option", { value: "all", text: t("common.all"), selected: f.category === "all" }),
        ...categories.map((c) => h("option", { value: c, text: t(`category.${c}`), selected: f.category === c }))
    );

    const search = h("input.input", {
        type: "search",
        placeholder: t("tweaks.searchPlaceholder"),
        value: f.search,
        oninput: (e) => {
            f.search = e.target.value;
            // Re-render only the list so the field keeps focus and caret.
            App.renderTweakList();
        },
    });

    return h(
        "div.page",
        null,
        pageHead(t("tweaks.title"), t("tweaks.subtitle", { count: State.tweaks.length })),
        h("div.row.row--wrap", null, riskChips, h("div.spacer"), categorySelect, search),
        !showRisky ? h("div.notice.mt-3", { text: t("tweaks.riskyHidden") }) : null,
        h(
            "div.list.mt-4",
            { id: "tweak-list" },
            list.length ? list.map((x) => tweakCard(x)) : h("div.empty", { text: t("tweaks.empty") })
        ),
        selectionBar()
    );
};

// --- game presets ------------------------------------------------------------

// A preset is a named selection, not a new mechanism: it names tweak ids that
// already exist in the catalogue. That also means a preset cannot promise more
// than the catalogue can deliver, so every card states how many of its tweaks
// are actually applicable on this machine instead of just a total.
Views.presets = () => {
    const presets = State.presets;
    if (presets === null) {
        return h("div.page", null, pageHead(t("presets.title")), h("div.empty", { text: t("common.loading") }));
    }

    const card = (preset) => {
        const tweaks = preset.ids.map((id) => State.tweaks.find((x) => x.id === id)).filter(Boolean);
        const usable = tweaks.filter((x) => !x.unavailable);
        const applied = usable.filter((x) => State.detection.get(x.id)?.status === "applied");
        const todo = usable.filter((x) => State.detection.get(x.id)?.status !== "applied");
        const unavailable = tweaks.length - usable.length;

        return h(
            "div.card.preset",
            null,
            h(
                "div.row",
                null,
                h("div.preset__mark", { style: { background: preset.color }, text: preset.short }),
                h(
                    "div",
                    null,
                    h("h2", { text: preset.name }),
                    h("p.muted", { text: preset.tagline })
                )
            ),
            h(
                "div.kv.mt-4",
                null,
                h("dt", { text: t("presets.applicable") }),
                h("dd", { text: String(usable.length) }),
                h("dt", { text: t("presets.alreadyApplied") }),
                h("dd", { text: String(applied.length) }),
                h("dt", { text: t("presets.notImplemented") }),
                h("dd", { text: String(unavailable) })
            ),
            unavailable
                ? h("p.faint.small.mt-3", { text: t("presets.unavailableHint", { n: unavailable }) })
                : null,
            h(
                "div.row.mt-4",
                null,
                h("button.btn", {
                    text: t("presets.review"),
                    disabled: !todo.length,
                    onclick: () => {
                        State.selection = new Set(todo.map((x) => x.id));
                        State.filters = { risk: "all", category: "all", search: "" };
                        App.go("tweaks");
                    },
                }),
                h("button.btn.btn--primary", {
                    text: t("presets.apply", { n: todo.length }),
                    disabled: !todo.length,
                    onclick: () => App.startApplyFlow(todo.map((x) => x.id)),
                })
            )
        );
    };

    return h(
        "div.page",
        null,
        pageHead(t("presets.title"), t("presets.subtitle")),
        h("div.notice.mt-3", { text: t("presets.note") }),
        h("div.grid.grid--2.mt-4", null, ...presets.map(card))
    );
};

// --- fixes -------------------------------------------------------------------

// A repair is a button, not a toggle: there is no "on" state to sit in, and
// running one you did not need is wasted time rather than an improvement. So
// no checkboxes and no pre-selection — each row runs on its own.
Views.fixes = () => {
    const list = State.tweaks.filter((x) => x.category === "Fixes");

    const row = (fix) => {
        const blocked = fix.requiresAdmin && !State.appInfo.isAdmin;
        return h(
            "div.tweak",
            null,
            h("span.dot.dot--unknown"),
            h(
                "div.tweak__body",
                null,
                h(
                    "div.tweak__name",
                    null,
                    fix.name,
                    riskBadge(fix.risk, { quiet: true }),
                    fix.requiresAdmin ? h("span.flag", { text: t("tweaks.needsAdmin") }) : null,
                    fix.requiresRestart ? h("span.flag.flag--warn", { text: t("tweaks.restart") }) : null,
                    fix.undoable ? null : h("span.flag.flag--warn", { text: t("tweaks.notReversible") })
                ),
                h("p.tweak__desc", { text: fix.description }),
                fix.unavailable
                    ? h("div.notice.notice--warn.mt-2", { text: `${t("tweaks.unavailableReason")}: ${fix.unavailable}` })
                    : null
            ),
            h(
                "div.tweak__actions",
                null,
                h("button.btn.btn--sm", {
                    text: t("common.details"),
                    onclick: () => Views.showTweakDetails(fix),
                }),
                h("button.btn.btn--sm.btn--primary", {
                    text: t("common.run"),
                    disabled: !!fix.unavailable || blocked,
                    onclick: () => App.startApplyFlow([fix.id]),
                })
            )
        );
    };

    return h(
        "div.page",
        null,
        pageHead(t("fixes.title"), t("fixes.subtitle")),
        h("div.notice.mt-3", { text: t("fixes.note") }),
        !State.appInfo.isAdmin ? h("div.notice.notice--warn.mt-3", { text: t("fixes.needsAdmin") }) : null,
        h("div.list.mt-4", null, ...list.map(row))
    );
};

// --- autostart ---------------------------------------------------------------

// Toggling here writes the same approval marker Task Manager writes, so an
// entry disabled in Panda Tweaks shows as disabled there too. The Run value and
// the shortcut are left untouched, which is why this is undoable.
Views.startup = () => {
    const entries = State.startup;

    if (entries === null) {
        return h("div.page", null, pageHead(t("startup.title")), h("div.empty", { text: t("common.loading") }));
    }

    const enabled = entries.filter((e) => e.enabled);

    const row = (entry) => {
        const needsAdmin = entry.scope.startsWith("hklm");
        const blocked = needsAdmin && !State.appInfo.isAdmin;
        return h(
            "div.tweak",
            null,
            h("input.switch", {
                type: "checkbox",
                checked: entry.enabled,
                disabled: blocked,
                "aria-label": entry.name,
                onchange: () => App.toggleStartup(entry),
            }),
            h(
                "div.tweak__body",
                null,
                h(
                    "div.tweak__name",
                    null,
                    entry.name,
                    entry.enabled ? null : h("span.badge.badge--muted", { text: t("startup.disabled") }),
                    needsAdmin ? h("span.flag", { text: t("tweaks.needsAdmin") }) : null
                ),
                // The command is the honest identity of an entry: two things can
                // call themselves "Updater".
                h("p.tweak__desc.mono", { text: entry.command || entry.source })
            ),
            h("div.tweak__actions", null, h("span.faint.small", { text: t(`startup.scope.${entry.scope}`) }))
        );
    };

    return h(
        "div.page",
        null,
        pageHead(
            t("startup.title"),
            t("startup.subtitle", { on: enabled.length, total: entries.length }),
            h("button.btn", { text: t("startup.refresh"), onclick: () => App.loadStartup(true) })
        ),
        h("div.notice.mt-3", { text: t("startup.note") }),
        entries.length
            ? h("div.list.mt-4", null, ...entries.map(row))
            : h("div.empty.mt-4", { text: t("startup.empty") })
    );
};

// --- services ----------------------------------------------------------------

// Services and cleanup targets are ordinary tweaks in the catalogue (see
// engine.js), so both pages are the shared tweak list narrowed to one category.
// Detection, undo and the details dialog come along for free.

Views.services = () => {
    const list = State.tweaks.filter((x) => x.category === "Services");
    return h(
        "div.page",
        null,
        pageHead(t("services.title"), t("services.subtitle", { count: list.length })),
        h("div.notice.mt-3", { text: t("services.note") }),
        h("div.list.mt-4", { id: "tweak-list" }, ...list.map((x) => tweakCard(x))),
        selectionBar()
    );
};

// --- cleanup -----------------------------------------------------------------

Views.cleanup = () => {
    const list = State.tweaks.filter((x) => x.category === "Cleanup");

    // Sizes come from the same capture the details dialog uses. It is a real
    // directory walk, so it runs when this page is opened, never on every scan.
    const row = (tweak) => {
        const scan = State.cleanupScan?.get(tweak.id);
        const selected = State.selection.has(tweak.id);
        return h(
            `div.tweak${selected ? ".tweak--selected" : ""}`,
            null,
            h("input.check", {
                type: "checkbox",
                checked: selected,
                "aria-label": tweak.name,
                onchange: (e) => {
                    e.target.checked ? State.selection.add(tweak.id) : State.selection.delete(tweak.id);
                    App.refreshSelection();
                },
            }),
            h(
                "div.tweak__body",
                null,
                h("div.tweak__name", null, tweak.name, h("span.flag.flag--warn", { text: t("tweaks.notReversible") })),
                h("p.tweak__desc", { text: tweak.description }),
                h(
                    "div.tweak__meta",
                    null,
                    h("span.mono", { text: tweak.affected[0] || "" }),
                    scan?.note ? h("span", { text: scan.note }) : null
                )
            ),
            h(
                "div.tweak__actions",
                null,
                scan === undefined
                    ? h("span.row", null, h("span.spinner"))
                    : // A folder that could not be opened is not an empty folder.
                      scan.now === null
                      ? h("span.flag", { text: t("cleanup.unreadable") })
                      : h("span.score__value", { text: scan.now, style: { fontSize: "14px" } })
            )
        );
    };

    return h(
        "div.page",
        null,
        pageHead(
            t("cleanup.title"),
            t("cleanup.subtitle"),
            h("button.btn", { text: t("cleanup.rescan"), onclick: () => App.scanCleanup(true) })
        ),
        h("div.notice.notice--warn.mt-3", { text: t("cleanup.warning") }),
        h("div.list.mt-4", { id: "tweak-list" }, ...list.map(row)),
        selectionBar()
    );
};

// --- debloat -----------------------------------------------------------------

Views.debloat = () => {
    const entries = State.debloat;

    if (!entries.length) {
        return h("div.page", null, pageHead(t("debloat.title"), t("debloat.subtitle")), h("div.empty", { text: t("common.loading") }));
    }

    const installed = entries.filter((e) => e.installed);
    // Only ever mass-selectable: installed, described by the catalogue, safe.
    // An app the catalogue does not know has to be ticked by hand.
    const selectable = installed.filter((e) => !e.protected && e.known && e.risk === "safe");

    const card = (entry) => {
        const selected = State.appSelection.has(entry.package);
        const blocked = !entry.installed || entry.protected;
        return h(
            `div.tweak${selected ? ".tweak--selected" : ""}${blocked ? ".tweak--disabled" : ""}`,
            null,
            h("input.check", {
                type: "checkbox",
                checked: selected,
                disabled: blocked,
                "aria-label": entry.name,
                onchange: (e) => {
                    e.target.checked ? State.appSelection.add(entry.package) : State.appSelection.delete(entry.package);
                    App.render();
                },
            }),
            h(
                "div.tweak__body",
                null,
                h(
                    "div.tweak__name",
                    null,
                    entry.name,
                    entry.known ? riskBadge(entry.risk, { quiet: true }) : null,
                    entry.protected ? h("span.badge.badge--warn", { text: t("debloat.protected") }) : null,
                    entry.keep ? h("span.badge.badge--warn", { text: t("debloat.keep") }) : null,
                    entry.recommended ? h("span.badge.badge--info", { text: t("debloat.recommended") }) : null
                ),
                entry.description ? h("p.tweak__desc", { text: entry.description }) : null,
                h(
                    "div.tweak__meta",
                    null,
                    // The exact package name is the thing that gets removed, so it
                    // is always shown — the friendly name above may be derived.
                    h("span.mono", { text: entry.package }),
                    entry.publisher ? h("span", { text: entry.publisher }) : null,
                    entry.protected ? h("span", { text: t("debloat.protectedWhy") }) : null
                )
            )
        );
    };

    // A flat list of 46 packages puts the news app next to the video codec that
    // makes films play. Grouping is what makes the page decidable.
    const section = (group, { collapsible = false } = {}) => {
        const rows = entries.filter((e) => e.group === group);
        if (!rows.length) return null;
        const open = !collapsible || State.debloatOpen.has(group);
        return h(
            "div.section",
            null,
            h(
                "div.section__title",
                null,
                collapsible
                    ? h("button.btn.btn--ghost.btn--sm", {
                          text: `${open ? "▾" : "▸"} ${t(`debloat.group.${group}`)}`,
                          onclick: () => {
                              open ? State.debloatOpen.delete(group) : State.debloatOpen.add(group);
                              App.render();
                          },
                      })
                    : h("h2", { text: t(`debloat.group.${group}`) }),
                h("span.muted", { text: String(rows.length) }),
                h("span.spacer"),
                h("span.faint.small", { text: t(`debloat.group.${group}.hint`) })
            ),
            open ? h("div.list", null, ...rows.map(card)) : null
        );
    };

    return h(
        "div.page",
        null,
        pageHead(
            t("debloat.title"),
            t("debloat.subtitleCount", { n: installed.filter((e) => !e.protected).length }),
            h("button.btn", {
                text: t("common.selectRecommended"),
                disabled: !selectable.some((e) => e.recommended),
                onclick: () => {
                    State.appSelection = new Set(selectable.filter((e) => e.recommended).map((e) => e.package));
                    App.render();
                },
            })
        ),
        State.debloatError ? h("div.notice.notice--bad", { text: State.debloatError }) : null,
        h("div.notice.notice--warn", { text: t("debloat.notReversibleWarning") }),
        section("recommended"),
        section("preinstalled"),
        section("thirdparty"),
        // Runtimes, codecs and shell pieces: present, removable in principle,
        // and almost always the wrong thing to remove. Folded away by default.
        section("components", { collapsible: true }),
        section("absent", { collapsible: true }),
        State.appSelection.size
            ? h(
                  "div.card.row.row--between.row--wrap.mt-5",
                  null,
                  h("strong", { text: t("common.selected", { n: State.appSelection.size }) }),
                  h(
                      "div.row",
                      null,
                      h("button.btn.btn--ghost", {
                          text: t("common.clearSelection"),
                          onclick: () => {
                              State.appSelection.clear();
                              App.render();
                          },
                      }),
                      h("button.btn.btn--danger", { text: t("common.remove"), onclick: () => App.removeSelectedApps() })
                  )
              )
            : null
    );
};

// A definition list of label/value pairs. A value of null is a reading that
// failed — it says "unknown" rather than being dropped, because a missing row
// and an unreadable one mean different things. undefined means "not applicable
// on this machine" and is skipped.
function kv(pairs) {
    const dl = h("dl.kv");
    for (const [key, value] of pairs) {
        if (value === undefined) continue;
        dl.append(h("dt", { text: key }), h("dd", { text: value === null ? t("common.unknown") : String(value) }));
    }
    return dl;
}

// Win32_Service reports start modes as fixed English identifiers on purpose —
// they are stable, unlike the localized names sc.exe prints. That makes them
// safe to match on, and something the UI has to translate rather than show.
const startMode = (v) => (v ? t(`startMode.${v}`) : v);

const yesNo = (v) => (v === null || v === undefined ? null : v ? t("common.enabled") : t("common.disabled"));

Views.system = () => {
    const scan = State.scan;
    if (!scan) {
        return h(
            "div.page",
            null,
            pageHead(t("system.title")),
            h("div.empty", { text: t("dashboard.neverScanned") }),
            h("button.btn.btn--primary.mt-4", { text: t("dashboard.scanNow"), onclick: () => App.scan() })
        );
    }

    const a = scan.analysis;
    const gpu = a.gpus?.[0];

    return h(
        "div.page",
        null,
        pageHead(t("system.title"), null, h("button.btn", { text: t("dashboard.scanAgain"), onclick: () => App.scan() })),

        h(
            "div.grid.grid--2",
            null,
            h(
                "div.card",
                null,
                h("h2", { text: t("system.windows") }),
                kv([
                    [t("system.windows"), a.windows?.caption],
                    [t("system.edition"), a.windows?.displayVer ? `${a.windows.edition} (${a.windows.displayVer})` : a.windows?.edition],
                    [t("system.build"), a.windows?.build ? `${a.windows.build}.${a.windows.ubr ?? 0}` : null],
                    [t("system.installed"), a.windows?.installDate],
                    [t("system.uptime"), a.windows?.uptimeHours != null ? `${a.windows.uptimeHours} h` : null],
                    [t("system.deviceType"), a.isLaptop ? t("system.laptop") : t("system.desktop")],
                ])
            ),

            h(
                "div.card",
                null,
                h("h2", { text: t("system.hardware") }),
                kv([
                    [t("system.cpu"), a.cpu?.name ? `${a.cpu.name} (${a.cpu.cores}C / ${a.cpu.threads}T)` : null],
                    [t("system.gpu"), gpu?.name],
                    [t("system.refreshRate"), gpu?.currentRefresh ? `${gpu.currentRefresh} / ${gpu.maxRefresh} Hz` : null],
                    [t("system.driverAge"), gpu?.driverAgeDays != null ? t("system.days", { n: gpu.driverAgeDays }) : null],
                    [
                        t("system.ram"),
                        a.ram?.totalGB
                            ? `${a.ram.totalGB} GB · ${a.ram.sticks}× · ${a.ram.configuredMHz}/${a.ram.ratedMHz} MHz`
                            : null,
                    ],
                ])
            ),

            h(
                "div.card",
                null,
                h("h2", { text: t("system.security") }),
                kv([
                    [t("system.secureBoot"), yesNo(a.secureBoot)],
                    [t("system.tpm"), a.tpm?.enabled === null ? t("system.needsAdminToRead") : yesNo(a.tpm?.enabled)],
                    [t("system.uac"), yesNo(a.uac?.enabled)],
                    [t("system.defender"), yesNo(a.defender?.realtimeEnabled)],
                    [t("system.firewall"), yesNo(a.firewall)],
                    [t("system.windowsUpdate"), startMode(a.windowsUpdate?.serviceStartMode)],
                ])
            ),

            h(
                "div.card",
                null,
                h("h2", { text: t("system.storage") }),
                kv([
                    ...(a.drives || []).map((d) => [d.letter, `${d.freeGB} / ${d.totalGB} GB (${d.freePct}%)`]),
                    ["SSD / HDD", a.systemDriveType],
                    [t("system.powerPlan"), a.powerPlan?.name],
                ])
            ),

            h(
                "div.card",
                null,
                h("h2", { text: t("system.services") }),
                kv([
                    [t("system.services"), a.serviceCounts?.total ? `${a.serviceCounts.running} / ${a.serviceCounts.total}` : null],
                    [t("system.scheduledTasks"), a.scheduledTaskCount],
                    [t("system.startupPrograms"), a.startup?.length ?? null],
                    [t("system.installedApps"), a.installedApps?.length ?? null],
                ])
            ),

            h(
                "div.card",
                null,
                h("h2", { text: t("system.startupPrograms") }),
                a.startup?.length
                    ? h("div.list--tight", null, ...a.startup.slice(0, 14).map((s) => h("div.small", { text: s.name })))
                    : h("p.faint", { text: t("common.none") })
            )
        )
    );
};

// --- history -----------------------------------------------------------------

Views.history = () => {
    const entries = State.history;
    if (!entries.length) {
        return h("div.page", null, pageHead(t("history.title"), t("history.subtitle")), h("div.empty", { text: t("history.empty") }));
    }

    const opLine = (record) => {
        const prev = record.previous;
        let was = t("common.unknown");
        if (prev && !prev.readFailed) {
            if (prev.exists === false) was = t("history.valueDidNotExist");
            else if (prev.value !== undefined && prev.value !== null) was = String(prev.value);
            else if (prev.startMode) was = prev.startMode;
            else if (prev.installed !== undefined) was = prev.installed ? t("debloat.installed") : t("debloat.notInstalled");
        }
        return h(
            "div.mt-2",
            null,
            h("div.code", { text: record.describe }),
            h(
                "div.small.faint.mt-1",
                null,
                `${t("history.previousValue")}: ${was}`,
                record.result.error ? ` · ${record.result.error}` : ""
            )
        );
    };

    const entryCard = (entry) =>
        h(
            "div.card",
            null,
            h(
                "div.row.row--between.row--wrap",
                null,
                h("div", null, h("h3", { text: entry.tweakName }), h("div.faint.small", { text: I18N.date(entry.appliedAt) })),
                h("div.row", null, statusBadge(entry.status), riskBadge(entry.risk || "safe"))
            ),
            h("div.mt-3", null, ...entry.ops.map(opLine)),
            h(
                "div.row.mt-4",
                null,
                entry.undoable && entry.status !== "undone"
                    ? h("button.btn.btn--sm", { text: t("common.undo"), onclick: () => App.undo(entry) })
                    : h("span.faint.small", { text: t("history.cannotUndo") }),
                entry.undoneAt ? h("span.faint.small", { text: `${t("history.undoneAt")}: ${I18N.date(entry.undoneAt)}` }) : null
            )
        );

    return h("div.page", null, pageHead(t("history.title"), t("history.subtitle")), h("div.list", null, ...entries.map(entryCard)));
};

// --- settings ----------------------------------------------------------------

const THEMES = ["dark", "light", "system"];

function toggleRow(labelKey, helpKey, settingKey) {
    return h(
        "div.row.row--between.mt-4",
        null,
        h(
            "div.field",
            null,
            h("span.field__label", { text: t(labelKey) }),
            helpKey ? h("span.field__help", { text: t(helpKey) }) : null
        ),
        h("input.switch", {
            type: "checkbox",
            checked: !!State.settings[settingKey],
            "aria-label": t(labelKey),
            onchange: (e) => App.updateSettings({ [settingKey]: e.target.checked }),
        })
    );
}

Views.settings = () =>
    h(
        "div.page",
        null,
        pageHead(t("settings.title")),

        h(
            "div.card",
            null,
            h("h2", { text: t("settings.appearance") }),
            h("div.field.mt-4", null, h("span.field__label", { text: t("settings.theme") })),
            h(
                "div.chips.mt-2",
                null,
                ...THEMES.map((theme) =>
                    h("button.chip", {
                        text: t(`settings.theme.${theme}`),
                        "aria-pressed": String(State.settings.theme === theme),
                        onclick: () => App.updateSettings({ theme }),
                    })
                )
            ),
            h("div.field.mt-5", null, h("span.field__label", { text: t("settings.language") })),
            h(
                "div.chips.mt-2",
                null,
                ...[
                    ["en", "English"],
                    ["de", "Deutsch"],
                ].map(([code, label]) =>
                    h("button.chip", {
                        text: label,
                        "aria-pressed": String(State.settings.language === code),
                        onclick: () => App.setLanguage(code),
                    })
                )
            )
        ),

        h(
            "div.card.mt-4",
            null,
            h("h2", { text: t("settings.safety") }),
            toggleRow("settings.askRestore", null, "askForRestorePoint"),
            toggleRow("settings.confirmApply", null, "confirmBeforeApply"),
            toggleRow("settings.showRisky", "settings.showRiskyHelp", "showRiskyTweaks")
        ),

        h(
            "div.card.mt-4",
            null,
            h("h2", { text: t("settings.data") }),
            h("p.muted.small.mt-2", { text: t("settings.noTelemetry") }),
            h(
                "div.row.row--wrap.mt-4",
                null,
                h("button.btn", { text: t("settings.openDataFolder"), onclick: () => window.panda.app.showItemInFolder("data") }),
                h("button.btn", { text: t("settings.exportLog"), onclick: () => App.exportLog() }),
                h("button.btn", { text: t("settings.clearLog"), onclick: () => App.clearLog() }),
                h("button.btn.btn--danger", { text: t("settings.resetSettings"), onclick: () => App.resetSettings() })
            )
        )
    );

// --- about -------------------------------------------------------------------

// The two addresses the app itself points at. Kept together so there is one
// place to change them, and both are https because the main process refuses
// anything else through openExternal.
const LINKS = {
    discord: "https://discord.gg/nV7m45NcBn",
    source: "https://github.com/pandatweaks0-pixel/panda-tweaks",
};

const linkButton = (label, url, cls = "") =>
    h(`button.btn${cls}`, {
        text: label,
        onclick: async () => {
            const res = await window.panda.app.openExternal(url);
            if (!res?.ok) toast(res?.error || t("error.generic"), "bad");
        },
    });

Views.about = () =>
    h(
        "div.page",
        null,
        pageHead(t("about.title")),
        h(
            "div.card",
            null,
            h("h2", { text: "Panda Tweaks" }),
            h("p.muted.mt-2", { text: t("app.tagline") }),
            h(
                "dl.kv.mt-4",
                null,
                h("dt", { text: t("about.version") }),
                h("dd", { text: State.appInfo.version || "—" }),
                h("dt", { text: t("about.dataLocation") }),
                h("dd.mono", { text: State.appInfo.dataPath || "—" })
            ),
            h("p.mt-4", { text: t("about.free") })
        ),
        h(
            "div.card.mt-4",
            null,
            h("h2", { text: t("about.communityTitle") }),
            h("p.muted.mt-2", { text: t("about.communityBody") }),
            h(
                "div.row.row--wrap.mt-4",
                null,
                linkButton(t("about.joinDiscord"), LINKS.discord, ".btn--primary"),
                linkButton(t("about.viewSource"), LINKS.source)
            ),
            h("p.small.faint.mt-3", { text: LINKS.source.replace(/^https:\/\//, "") })
        ),
        h(
            "div.card.mt-4",
            null,
            h("h2", { text: t("about.licenseTitle") }),
            h("p.muted.mt-2", { text: t("about.licenseBody") })
        )
    );
