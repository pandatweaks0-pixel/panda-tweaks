"use strict";

// Start screen: animated rain backdrop plus the reveal timing.
// Start screen; the colour is
// read from the app's accent token so it follows the user's theme.

const Splash = {
    minVisibleMs: 2100, // let the loading bar finish rather than blink out
    shownAt: Date.now(),
    stopRain: null,

    start() {
        this.stopRain = this.rain();
    },

    hide() {
        const wait = Math.max(0, this.minVisibleMs - (Date.now() - this.shownAt));
        setTimeout(() => {
            const node = document.getElementById("splash");
            if (!node) return;
            node.classList.add("hide");
            // Free the animation loop once the fade has finished.
            setTimeout(() => {
                this.stopRain?.();
                node.remove();
            }, 600);
        }, wait);
    },

    accentRgb() {
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        const hex = /^#?([0-9a-f]{6})$/i.exec(raw);
        if (!hex) return "116,192,252";
        const n = parseInt(hex[1], 16);
        return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    },

    rain() {
        const canvas = document.getElementById("splash-rain");
        if (!canvas) return null;
        const ctx = canvas.getContext("2d");
        const rgb = this.accentRgb();

        let w = 0;
        let h = 0;
        let drops = [];
        let splashes = [];
        let running = true;
        let frameId = null;

        const makeDrop = () => ({
            x: Math.random() * w,
            y: Math.random() * h,
            len: 10 + Math.random() * 20,
            sp: 3 + Math.random() * 5,
            op: 0.18 + Math.random() * 0.32,
        });

        const resize = () => {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
            const count = Math.min(220, Math.floor(w / 8));
            drops = Array.from({ length: count }, makeDrop);
        };

        const frame = () => {
            if (!running) return;
            ctx.clearRect(0, 0, w, h);

            // Faint pool of light along the bottom edge.
            const glow = ctx.createLinearGradient(0, h - 130, 0, h);
            glow.addColorStop(0, `rgba(${rgb},0)`);
            glow.addColorStop(1, `rgba(${rgb},0.07)`);
            ctx.fillStyle = glow;
            ctx.fillRect(0, h - 130, w, 130);

            ctx.lineWidth = 1.4;
            ctx.lineCap = "round";
            for (const d of drops) {
                ctx.strokeStyle = `rgba(${rgb},${d.op})`;
                ctx.beginPath();
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(d.x - 1.4, d.y + d.len);
                ctx.stroke();
                d.y += d.sp;
                d.x -= 0.35;
                if (d.y > h) {
                    if (Math.random() < 0.5 && splashes.length < 60) {
                        splashes.push({ x: d.x, y: h - 2, r: 0, a: 0.35 });
                    }
                    d.y = -d.len;
                    d.x = Math.random() * w;
                }
            }

            for (let i = splashes.length - 1; i >= 0; i--) {
                const sp = splashes[i];
                ctx.strokeStyle = `rgba(${rgb},${sp.a})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, sp.r, Math.PI * 1.15, Math.PI * 1.85);
                ctx.stroke();
                sp.r += 1.3;
                sp.a *= 0.9;
                if (sp.a < 0.03) splashes.splice(i, 1);
            }

            frameId = requestAnimationFrame(frame);
        };

        window.addEventListener("resize", resize);
        resize();
        frame();

        return () => {
            running = false;
            if (frameId) cancelAnimationFrame(frameId);
            window.removeEventListener("resize", resize);
        };
    },
};

// Reduced-motion users get the screen without the rain animation.
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    Splash.start();
}
