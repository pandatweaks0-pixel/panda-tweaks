"use strict";

// Small DOM helpers. Elements are built as real nodes rather than HTML strings,
// so no tweak name or registry value from the system can ever be parsed as
// markup.

// h("div.card", { onclick }, child, child)
function h(spec, props = null, ...children) {
    const [tag, ...classes] = String(spec).split(".");
    const el = document.createElement(tag || "div");
    if (classes.length) el.className = classes.join(" ");

    for (const [key, value] of Object.entries(props || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") {
            el.className = el.className ? `${el.className} ${value}` : value;
        } else if (key === "style") {
            // Applied through the CSSOM: the Content-Security-Policy blocks
            // inline style attributes, but this path is allowed.
            for (const [prop, val] of Object.entries(value)) el.style[prop] = val;
        } else if (key === "text") {
            el.textContent = String(value);
        } else if (key === "html") {
            throw new Error("Raw HTML is not allowed — build nodes instead");
        } else if (key.startsWith("on") && typeof value === "function") {
            el.addEventListener(key.slice(2), value);
        } else if (key === "dataset") {
            for (const [d, v] of Object.entries(value)) el.dataset[d] = v;
        } else if (value === true) {
            el.setAttribute(key, "");
        } else {
            el.setAttribute(key, String(value));
        }
    }

    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

const clear = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
};

const mount = (node, ...children) => {
    clear(node);
    node.append(...children.flat(Infinity).filter(Boolean));
    return node;
};

// --- icons -------------------------------------------------------------------

const ICON_PATHS = {
    dashboard: "M3 12h7V3H3v9Zm0 9h7v-6H3v6Zm11 0h7V12h-7v9Zm0-18v6h7V3h-7Z",
    star: "m12 3 2.6 5.6 6.4.8-4.7 4.3 1.2 6.3L12 17l-5.5 3 1.2-6.3L3 9.4l6.4-.8L12 3Z",
    sliders: "M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4",
    broom: "m3 21 6-6M14 3l7 7-6.5 2.5L11 9 14 3Zm-4 6 5 5-5 5-5-5 5-5Z",
    chip: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6z",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
    gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2L15 3H9l-.5 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8.3 8.3 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2L9 21h6l.5-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2Z",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.5v.5",
    stack: "M12 3 3 7.5l9 4.5 9-4.5L12 3ZM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5",
    power: "M12 3v9M7.8 6.8a7.5 7.5 0 1 0 8.4 0",
    wrench: "M15.5 3.5a5 5 0 0 0-6.2 6.4L3 16.2 6.8 20l6.3-6.3a5 5 0 0 0 6.4-6.2l-3 3-2.5-.7-.7-2.5 3-3Z",
    gamepad: "M7 12h4M9 10v4M15.5 11.5h.01M18 13.5h.01M7.5 7h9a5 5 0 0 1 4.9 6l-.8 4a2.6 2.6 0 0 1-4.6 1.1L14.5 16h-5l-1.5 2.1A2.6 2.6 0 0 1 3.4 17l-.8-4a5 5 0 0 1 4.9-6Z",
    trash: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
};

function icon(name, size = 17) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", ICON_PATHS[name] || ICON_PATHS.info);
    svg.append(p);
    return svg;
}

// --- badges ------------------------------------------------------------------

// In a long list "safe" sits on nearly every row, so it stops being a signal
// and becomes texture. Quiet mode drops it and keeps the notable levels, which
// is what the reader is scanning for. Detail views still show it in full.
const riskBadge = (risk, { quiet = false } = {}) =>
    quiet && risk === "safe" ? null : h(`span.badge.badge--${risk}`, { text: t(`risk.${risk}`) });

function statusBadge(status) {
    const tone = {
        applied: "safe",
        undone: "info",
        "not-applied": "muted",
        partial: "advanced",
        unverified: "advanced",
        "undo-partial": "advanced",
        unknown: "muted",
        unavailable: "muted",
        failed: "risky",
        "undo-failed": "risky",
    }[status] || "muted";
    return h(`span.badge.badge--${tone}`, { text: t(`status.${status}`) });
}

function scoreTone(score) {
    if (score === null || score === undefined) return "unknown";
    if (score >= 80) return "good";
    if (score >= 55) return "fair";
    return "poor";
}

// --- modal -------------------------------------------------------------------

const modalRoot = () => document.getElementById("modal-root");

// Returns a promise that settles with whatever a button handler passes to
// close(). Escape and backdrop clicks resolve with null.
function openModal({ title, subtitle, body, buttons = [], wide = false, dismissible = true }) {
    return new Promise((resolve) => {
        const root = modalRoot();
        let settled = false;

        const close = (value = null) => {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKey);
            root.hidden = true;
            clear(root);
            resolve(value);
        };

        const onKey = (e) => {
            if (e.key === "Escape" && dismissible) close(null);
        };

        const foot = h("div.modal__foot");
        for (const b of buttons) {
            if (b.spacer) {
                foot.append(h("div.spacer"));
                continue;
            }
            foot.append(
                h(
                    `button.btn${b.variant ? `.btn--${b.variant}` : ""}`,
                    {
                        onclick: async (e) => {
                            if (b.keepOpen) return b.onClick?.(e, close);
                            close(b.value !== undefined ? b.value : true);
                            await b.onClick?.(e);
                        },
                        disabled: b.disabled,
                    },
                    b.label
                )
            );
        }

        const dialog = h(
            `div.modal${wide ? ".modal--wide" : ""}`,
            { role: "dialog", "aria-modal": "true", "aria-label": title },
            h("div.modal__head", null, h("h2", { text: title }), subtitle ? h("p.muted.mt-1", { text: subtitle }) : null),
            h("div.modal__body", null, body),
            buttons.length ? foot : null
        );

        mount(root, h("div", { onclick: (e) => e.target === e.currentTarget && dismissible && close(null) }, dialog));
        // The backdrop click target is the root itself.
        root.onclick = (e) => e.target === root && dismissible && close(null);
        root.hidden = false;
        document.addEventListener("keydown", onKey);
        dialog.querySelector("button, [tabindex], input")?.focus();
    });
}

// A refusal, not a question. One button, because there is nothing to decide —
// offering "Cancel / Apply" for something the app will not do either way reads
// as a choice and gets clicked through.
const alertModal = ({ title, message }) =>
    openModal({
        title,
        body: h("p", { text: message }),
        buttons: [{ label: t("common.ok"), variant: "primary", value: true }],
    });

const confirmModal = ({ title, message, confirmLabel, variant = "primary" }) =>
    openModal({
        title,
        body: h("p", { text: message }),
        buttons: [
            { label: t("common.cancel"), value: false },
            { label: confirmLabel || t("common.apply"), variant, value: true },
        ],
    });

// --- toast -------------------------------------------------------------------

function toast(message, tone = "ok", ms = 4200) {
    const node = h(`div.toast.toast--${tone}`, { text: message });
    document.getElementById("toast-root").append(node);
    setTimeout(() => {
        node.style.opacity = "0";
        node.style.transform = "translateX(16px)";
        node.style.transition = "opacity .2s, transform .2s";
        setTimeout(() => node.remove(), 220);
    }, ms);
}

// --- misc --------------------------------------------------------------------

// Donut used for the overall health figure.
function ring(percent, size = 96) {
    // Stroke scales with the ring so a large ring does not look like a hairline.
    const stroke = Math.max(8, Math.round(size * 0.075));
    const r = (size - stroke) / 2;
    const circumference = 2 * Math.PI * r;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("aria-hidden", "true");

    const make = (color, dash) => {
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", size / 2);
        c.setAttribute("cy", size / 2);
        c.setAttribute("r", r);
        c.setAttribute("fill", "none");
        c.setAttribute("stroke", color);
        c.setAttribute("stroke-width", stroke);
        c.setAttribute("stroke-linecap", "round");
        if (dash !== undefined) {
            c.setAttribute("stroke-dasharray", `${dash} ${circumference}`);
            c.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
        }
        return c;
    };

    svg.append(make("var(--surface-sunken)"));
    if (percent !== null && percent !== undefined) {
        const tone = scoreTone(percent);
        const color = { good: "var(--ok)", fair: "var(--warn)", poor: "var(--bad)" }[tone] || "var(--text-faint)";
        svg.append(make(color, (circumference * percent) / 100));
    }
    return svg;
}

function meter(percent, tone) {
    const fill = h(`div.meter__fill${tone ? `.meter__fill--${tone}` : ""}`);
    fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
    return h("div.meter", null, fill);
}
