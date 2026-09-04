"use strict";

// Builds the public website into site/ .
//
// The catalogue is GENERATED from the same JSON the app ships, never typed by
// hand. A hand-written list of two hundred tweaks is out of date the first time
// someone edits tweaks.json, and a page that promises a tweak the app does not
// have is worse than no page at all.
//
// It also refuses to advertise a tweak that cannot run: 41 of the 147 entries
// still carry an "unsupported" operation left over from the original import
// (powershell, powercfg, bcdedit, netsh). Those are counted and
// listed separately rather than folded into the headline number.
//
//   node tools/build-site.js
//
// Layout: sticky nav, eyebrow labels over
// every section head, a two-button hero, benefit tiles, a Discord band, a FAQ.
// The wording, the numbers and the accent are this product's own: their review
// quotes belong to real people in their Discord, and their FPS figures were
// measured on their machine, so neither can honestly appear here.
//
// The font stack asks for Inter and falls back to what Windows already has.
// Loading it from Google would put a request to a third party on every visit,
// which is a strange thing to do on a page whose selling point is that nothing
// leaves your PC.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "src", "data");
const OUT = path.join(ROOT, "site");

// ---------------------------------------------------------------- config --

const CONFIG = {
    // The Discord invite. This is the one address the site has, and every button
    // on the page points at it - the build is handed out through Discord and
    // nowhere else, so there is deliberately no download URL here to configure.
    // If that ever changes, a download button goes back into the hero and the
    // "Why is there no download button" section below comes out.
    //
    // Must be an invite set to never expire, and pointing at a channel that
    // will still exist next year. The first one here expired quietly a few
    // weeks after it went up, which on a Discord-only site means every button
    // on every page leads nowhere and nobody can reach the app at all - and
    // nothing reports it, because the page still builds and still serves.
    //
    // This one is verified permanent (the invite API returns expires_at: null)
    // and points at the welcome channel. Before replacing it, check the
    // replacement the same way:
    //   curl -s https://discord.com/api/v10/invites/<code>
    discord: "https://discord.gg/nV7m45NcBn",
};

const pkg = require(path.join(ROOT, "package.json"));
const readData = (name) => JSON.parse(fs.readFileSync(path.join(DATA, `${name}.json`), "utf8"));

const tweaks = readData("tweaks");
const fixes = readData("fixes");
const services = readData("services");
const debloat = readData("debloat");
const presets = readData("presets");

const isBroken = (t) => (t.operations || []).some((o) => o.type === "unsupported");
const working = tweaks.filter((t) => !isBroken(t));
const pending = tweaks.filter(isBroken);

// ----------------------------------------------------------------- helpers --

const esc = (s) =>
    String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

// What a tweak actually touches, in one line. This is the whole reason a
// visitor would trust the page: the exact key, not "optimises your system".
function describeOp(op) {
    switch (op.type) {
        case "registry":
            return op.action === "delete"
                ? `${op.hive}\\${op.key}\\${op.name} — remove`
                : `${op.hive}\\${op.key}\\${op.name} = ${op.value}`;
        case "service":
            return `Service "${op.name}" → ${op.startMode}`;
        case "scheduledTask":
            return `Task "${op.path}" → ${op.enabled ? "enabled" : "disabled"}`;
        case "cleanup":
            return `Clean up: ${op.target}`;
        case "command":
            return `Action: ${op.command}`;
        case "unsupported":
            return `Not implemented yet: ${op.reason}`;
        default:
            return op.type;
    }
}

const RISK_LABEL = { safe: "Safe", advanced: "Advanced", risky: "Risky" };

// One shape for every catalogue row, whatever file it came from, so the
// filtering script below has a single thing to understand.
const row = ({ name, description, group, risk, targets, note }) => ({
    name,
    description,
    group,
    risk: risk || "safe",
    targets: targets || [],
    note: note || null,
});

const items = [
    ...working.map((t) =>
        row({
            name: t.name,
            description: t.description,
            group: t.category,
            risk: t.risk,
            targets: (t.operations || []).map(describeOp),
            note: t.requiresRestart ? "Restart needed" : null,
        })
    ),
    ...fixes.map((f) =>
        row({
            name: f.name,
            description: f.description,
            group: "Repairs",
            risk: "safe",
            targets: (f.operations || []).map(describeOp),
        })
    ),
    ...debloat.map((d) =>
        row({
            name: d.name,
            description: d.description,
            group: "Preinstalled apps",
            risk: d.risk,
            targets: [`Store package: ${d.package}`],
            note: d.recommended ? "Suggested for removal" : null,
        })
    ),
    ...services.map((s) =>
        row({
            name: s.label,
            description: s.description,
            group: "Services",
            risk: s.risk,
            targets: [`Service "${s.name}" → disabled`],
            note: s.recommended ? "Safe to disable" : null,
        })
    ),
];

const groups = [...new Set(items.map((i) => i.group))];
const riskyCount = items.filter((i) => i.risk === "risky").length;

const STATS = [
    [working.length, "tweaks"],
    [fixes.length, "repairs"],
    [debloat.length, "removable apps"],
    [services.length, "services"],
    [presets.length, "game presets"],
];

// -------------------------------------------------------------------- css --

const CSS = `
:root{
  --bg:#05070b; --panel:#0c1017; --panel2:#080b11; --elev:#131924;
  --line:#181e2b; --line2:#242c3c;
  --text:#edf1f7; --muted:#8994a6; --faint:#525c6e;
  --acc:#4ade80; --acc2:#86efac; --acc-ink:#04140a;
  --ok:#33c27a; --warn:#fbbf24; --bad:#f87171; --info:#74c0fc;
  --blurple:#5865f2;
  --sans:"Inter",system-ui,"Segoe UI",Roboto,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Consolas,monospace;
  --wrap:1200px; --pill:999px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
  font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}
section{padding:86px 0}
.eyebrow{font-size:12px;font-weight:800;letter-spacing:.16em;color:var(--acc);
  text-transform:uppercase;margin:0 0 14px}
h2{font-size:clamp(28px,4.4vw,46px);font-weight:900;letter-spacing:-.035em;
  line-height:1.05;margin:0 0 16px}
.sub{color:var(--muted);max-width:660px;margin:0 0 40px;font-size:17px}

/* ------------------------------------------------------------------ nav -- */
.topbar{background:var(--acc);color:var(--acc-ink);text-align:center;
  font-size:13px;font-weight:700;padding:8px 16px;letter-spacing:.01em}
header{position:sticky;top:0;z-index:60;background:rgba(5,7,11,.86);
  backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;gap:26px;height:70px}
.brand{display:flex;align-items:center;gap:11px;margin-right:auto;
  font-weight:900;font-size:15px;letter-spacing:.06em;line-height:1}
.brand .mark{width:34px;height:34px;border-radius:10px;background:var(--acc);
  color:var(--acc-ink);display:grid;place-items:center;font-size:17px;font-weight:900}
.brand span{display:block}
.brand .b2{color:var(--muted);font-size:11px;letter-spacing:.22em}
.nav .link{color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase}
.nav .link:hover{color:var(--text)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
  border-radius:var(--pill);padding:12px 22px;font-size:14px;font-weight:800;
  border:1px solid var(--line2);color:var(--text);background:var(--elev);
  white-space:nowrap;transition:.15s;cursor:pointer}
.btn:hover{border-color:var(--faint);transform:translateY(-1px)}
.btn--acc{background:var(--acc);color:var(--acc-ink);border-color:transparent}
.btn--acc:hover{background:var(--acc2)}
.btn--dc{background:var(--blurple);color:#fff;border-color:transparent}
.btn--dc:hover{filter:brightness(1.12)}
.btn--lg{padding:16px 30px;font-size:15.5px}
@media(max-width:940px){.nav .link{display:none}}

/* ----------------------------------------------------------------- hero -- */
.hero{padding:104px 0 84px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:-40% 0 auto 0;height:620px;
  background:radial-gradient(760px 380px at 50% 40%,rgba(74,222,128,.16),transparent 68%);
  pointer-events:none}
.hero .wrap{position:relative}
.hero h1{font-size:clamp(38px,7.4vw,82px);font-weight:900;letter-spacing:-.035em;
  line-height:.98;margin:0 0 24px}
.hero h1 em{font-style:normal;color:var(--acc)}
.hero .lede{font-size:clamp(16.5px,2vw,19px);color:var(--muted);max-width:660px;
  margin:0 auto 34px}
.cta{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.hero .fine{margin-top:22px;font-size:13px;color:var(--faint)}

/* ---------------------------------------------------------------- tiles -- */
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:18px;overflow:hidden}
.tile{background:var(--panel);padding:30px 24px}
.tile b{display:block;font-size:12.5px;font-weight:900;letter-spacing:.12em;
  color:var(--acc);text-transform:uppercase;margin-bottom:10px}
.tile p{margin:0;color:var(--muted);font-size:14.5px}
@media(max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}}
@media(max-width:520px){.tiles{grid-template-columns:1fr}}

/* ---------------------------------------------------------------- stats -- */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:18px;overflow:hidden}
.stat{background:var(--panel);padding:28px 16px;text-align:center}
.stat b{display:block;font-size:36px;font-weight:900;letter-spacing:-.03em;color:var(--acc);
  line-height:1.1}
.stat span{font-size:13px;color:var(--muted)}
@media(max-width:820px){.stats{grid-template-columns:repeat(2,1fr)}
  .stat:last-child{grid-column:1/-1}}

/* ---------------------------------------------------------------- cards -- */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}
.card .ico{font-size:22px;margin-bottom:14px;display:block}
.card h3{margin:0 0 9px;font-size:17.5px;font-weight:800;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:14.5px}

/* two-column explainer (recommended / skipped) */
.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.split{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}
.panel h3{margin:0 0 4px;font-size:12.5px;font-weight:900;letter-spacing:.12em;
  text-transform:uppercase;color:var(--acc)}
.panel h3.dim{color:var(--faint)}
.panel ul{margin:16px 0 0;padding:0;list-style:none}
.panel li{position:relative;padding-left:26px;margin-bottom:13px;color:var(--muted);font-size:14.5px}
.panel li::before{content:"→";position:absolute;left:0;color:var(--acc);font-weight:800}
.panel.dim li::before{content:"×";color:var(--faint)}

/* ------------------------------------------------------------ catalogue -- */
.tools{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
input[type=search],select{background:var(--panel2);border:1px solid var(--line2);
  color:var(--text);border-radius:var(--pill);padding:12px 18px;font:inherit;font-size:14.5px;outline:none}
input[type=search]{flex:1;min-width:240px}
input[type=search]:focus,select:focus{border-color:var(--acc)}
.count{color:var(--faint);font-size:13px;margin:0 0 12px}
.list{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.item{padding:20px 24px;border-top:1px solid var(--line);display:block}
.item:first-child{border-top:none}
.item__name{font-weight:750;display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:15.5px}
.item__desc{color:var(--muted);font-size:14.5px;margin:6px 0 0}
.item__targets{margin:10px 0 0;padding:0;list-style:none}
.item__targets li{font-family:var(--mono);font-size:12.5px;color:var(--faint);
  background:var(--panel2);border:1px solid var(--line);border-radius:9px;
  padding:6px 11px;margin-top:5px;overflow-wrap:anywhere}
.badge{font-size:11px;font-weight:800;letter-spacing:.04em;padding:3px 10px;
  border-radius:var(--pill);border:1px solid transparent;white-space:nowrap;text-transform:uppercase}
.badge--safe{color:var(--ok);background:rgba(51,194,122,.11);border-color:rgba(51,194,122,.3)}
.badge--advanced{color:var(--warn);background:rgba(251,191,36,.11);border-color:rgba(251,191,36,.3)}
.badge--risky{color:var(--bad);background:rgba(248,113,113,.11);border-color:rgba(248,113,113,.3)}
.badge--group{color:var(--muted);background:var(--panel2);border-color:var(--line2)}
.badge--note{color:var(--info);background:rgba(116,192,252,.1);border-color:rgba(116,192,252,.3)}
.empty{padding:52px;text-align:center;color:var(--faint)}

/* risk legend */
.legend{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}
@media(max-width:760px){.legend{grid-template-columns:1fr}}

/* honest block */
.honest{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--warn);
  border-radius:16px;padding:30px}
.honest h3{margin:0 0 10px;font-size:19px;font-weight:800;letter-spacing:-.01em}
.honest p{margin:0;color:var(--muted);font-size:15px}

/* discord band */
.band{background:linear-gradient(150deg,rgba(88,101,242,.2),rgba(74,222,128,.09));
  border:1px solid var(--line2);border-radius:22px;padding:56px 40px;text-align:center}
.band h2{margin-bottom:12px}
.band .sub{margin:0 auto 34px}
.dcgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:0 0 34px;text-align:left}
.dcgrid div{background:var(--panel);padding:24px 20px}
.dcgrid b{display:block;font-size:15px;margin:8px 0 5px;font-weight:800}
.dcgrid p{margin:0;color:var(--muted);font-size:13.5px}
@media(max-width:820px){.dcgrid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:480px){.dcgrid{grid-template-columns:1fr}}
.handle{font-family:var(--mono);color:var(--muted);font-size:14px;margin-top:18px}

/* steps */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;counter-reset:s}
@media(max-width:820px){.steps{grid-template-columns:1fr}}
.step{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px;
  counter-increment:s;position:relative}
.step::before{content:counter(s);display:grid;place-items:center;width:32px;height:32px;
  border-radius:10px;background:var(--acc);color:var(--acc-ink);font-weight:900;font-size:15px;
  margin-bottom:16px}
.step h3{margin:0 0 7px;font-size:17px;font-weight:800}
.step p{margin:0;color:var(--muted);font-size:14.5px}

/* faq */
details{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:20px 24px;margin-bottom:10px}
details[open]{border-color:var(--line2)}
summary{cursor:pointer;font-weight:750;font-size:16px;list-style:none;
  display:flex;justify-content:space-between;gap:16px;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--acc);font-weight:900;font-size:20px;line-height:1}
details[open] summary::after{content:"−"}
details p{margin:14px 0 0;color:var(--muted);font-size:14.5px}

footer{border-top:1px solid var(--line);padding:48px 0;color:var(--faint);font-size:13.5px}
.foot{display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.foot a{color:var(--muted)}
.foot .sp{margin-left:auto}
`;

// ------------------------------------------------------------------ data --

const HERO_TILES = [
    ["Real undo", "The old value is read and stored before anything is written. Undo puts back your value, not a guessed Windows default."],
    ["Nothing hidden", "Every change names the exact registry key or service it touches — in the app before it runs, and in full on this page."],
    ["No free-form commands", "The interface cannot run a shell. Every action is a typed, validated operation, even when the app is elevated."],
    ["No account, no tracking", "No sign-up, no telemetry, no connection to anywhere except the links you click yourself."],
];

const FEATURES = [
    ["🧠", "System analysis", "Reads your CPU, GPU, memory, drives, refresh rate and power plan, then suggests only what actually does something on this machine."],
    ["🎮", `${presets.length} game presets`, `${presets.map((p) => p.name).join(" and ")} — a ready-made selection each, running through the same confirmation as everything else.`],
    ["🔧", `${fixes.length} repairs`, "Audio, Bluetooth, network, Windows Update, Store, Explorer. One click restores the Windows default — including what another tool broke."],
    ["🧹", `${debloat.length} removable apps`, "Preinstalled Store apps with a hard block list: packages Windows depends on cannot be selected at all."],
    ["⚙", `${services.length} curated services`, "A reviewed list rather than a blanket sweep. Each service with a plain-English description and a risk label."],
    ["🕘", "History with per-item undo", "Every change lands in the history with its before and after. Roll one back, or all of them."],
];

const RECOMMENDED_EXAMPLES = [
    "Game DVR still on? It gets suggested — it costs real frames in the background",
    "Power plan on Balanced? High performance goes on the list",
    "Monitor running below its maximum refresh rate? The analysis tells you",
    "Telemetry services that are actually running — not the ones your Windows never had",
];

const SKIPPED_EXAMPLES = [
    "On a laptop? Anything that keeps the hardware awake is left out — it costs more battery than it gains",
    "Risky tweaks are never recommended automatically, however good the number would look",
    "Anything already applied leaves the list instead of being suggested twice",
    "A service your Windows does not even have counts as done, not as a failure",
    "A value Windows protects on your build is remembered and not offered again",
];

const RISK_LEGEND = [
    ["safe", "Safe", "No stated downside. Fine for anyone, and this is the majority."],
    ["advanced", "Advanced", "Gains something, costs something else — or depends on your hardware. The description says which."],
    ["risky", "Risky", "Can take away a feature you rely on. Hidden by default and never recommended automatically."],
];

const DISCORD_TILES = [
    ["📥", "The download", "The official file, always the current version."],
    ["💬", "Help", "Something broken, or a question about a setting? Just ask."],
    ["📜", "Source code", "MIT licensed. Read every line before you run it."],
    ["🔔", "New releases", "New tweaks and fixes are announced there first."],
];

const STEPS = [
    ["Join the Discord", "The build lives in the download channel. No account setup beyond Discord itself, and nothing to pay."],
    ["Run it", "One portable .exe — no installer, nothing added to startup. It starts without administrator rights and only asks for them when a change genuinely needs them."],
    ["Analyse my PC", "One button. After that you can see what is worth doing on your machine — nothing is applied until you confirm."],
];

const FAQ = [
    ["Is it really free?", "Yes. MIT licensed, no account, no payment, no pro version, nothing behind a paywall. The source is open, so you can read what happens before you run it."],
    ["Why does Windows say “unknown publisher”?", "Because the file is not code-signed. A signing certificate costs several hundred euros a year and this app is free. Click More info, then Run anyway."],
    ["Does it need administrator rights?", "Not to start. Analysis and every change inside your own user account run as a normal user. Windows only prompts once you apply something that reaches system-wide settings."],
    ["Can I undo everything?", "Yes. The previous value is captured before every change, and the history rolls back each one individually. The app also offers a Windows restore point on first launch and then checks that it was really created."],
    ["Where do I actually download it?", "In the Discord, in the download channel. There is no download button on this site on purpose — see the section above for why. Joining takes one click and costs nothing."],
    [`Why ${working.length} tweaks and not ${tweaks.length}?`, `Because ${pending.length} of them do not run yet. They were imported as raw command lines; those ${pending.length} have not been translated into validated operations. The app marks them unavailable and this page does not count them. A bigger number would be easy — it just would not be true.`],
    ["I am not technical. Can I use this?", "Yes. Press Analyse once and you get a plain-language list of what is recommended and why. Nothing is applied without your confirmation, and risky changes are hidden from the start."],
    ["How much faster will my PC get?", "That depends entirely on your PC, and any specific number on a website is a guess. A freshly installed machine gains little, a cluttered one can gain a lot. The system analysis shows you up front where there is anything to gain on yours."],
];

// ------------------------------------------------------------------ html --

const itemHtml = (i) => `
        <article class="item" data-group="${esc(i.group)}" data-risk="${esc(i.risk)}" data-search="${esc(
    (i.name + " " + i.description + " " + i.targets.join(" ")).toLowerCase()
)}">
          <div class="item__name">${esc(i.name)}
            <span class="badge badge--${esc(i.risk)}">${esc(RISK_LABEL[i.risk] || i.risk)}</span>
            <span class="badge badge--group">${esc(i.group)}</span>
            ${i.note ? `<span class="badge badge--note">${esc(i.note)}</span>` : ""}
          </div>
          <p class="item__desc">${esc(i.description)}</p>
          <ul class="item__targets">${i.targets.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        </article>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panda Tweaks — the free Windows optimizer you can read</title>
<meta name="description" content="${working.length} tweaks, ${fixes.length} repairs and a debloater for Windows 10 and 11. Every change names the exact registry key and can be rolled back one at a time. Free, open source, no account.">
<meta property="og:title" content="Panda Tweaks">
<meta property="og:description" content="Make Windows faster — and read every change before it happens.">
<meta property="og:type" content="website">
<meta name="theme-color" content="#05070b">
<style>${CSS}</style>
</head>
<body id="top">

<div class="topbar">The download is on Discord only — free, one click, no account beyond Discord itself</div>

<header>
  <div class="wrap nav">
    <a class="brand" href="#top">
      <span class="mark">P</span>
      <span><span>PANDA</span><span class="b2">TWEAKS</span></span>
    </a>
    <a class="link" href="#features">Features</a>
    <a class="link" href="#analysis">Analysis</a>
    <a class="link" href="#catalogue">All tweaks</a>
    <a class="link" href="#faq">FAQ</a>
    <a class="btn btn--dc" href="${esc(CONFIG.discord)}" target="_blank" rel="noopener">Join the Discord</a>
  </div>
</header>

<main>

  <div class="hero">
    <div class="wrap">
      <p class="eyebrow">Windows 10 &amp; 11 — 100% free</p>
      <h1>Read first.<br><em>Then optimize.</em></h1>
      <p class="lede">Most tweaking tools hand everyone the same preset and never say what they
        touched. Panda Tweaks reads your PC first, suggests only what actually helps on your
        machine — and shows the exact registry key behind every single change.</p>
      <div class="cta">
        <a class="btn btn--dc btn--lg" href="${esc(CONFIG.discord)}" target="_blank" rel="noopener">Join Discord &amp; download</a>
        <a class="btn btn--lg" href="#catalogue">See every change first</a>
      </div>
      <p class="fine">The download lives in our Discord — that is the only place to get it.<br>
        Version ${esc(pkg.version)} · portable, no install · everything reversible one at a time</p>
    </div>
  </div>

  <div class="wrap"><div class="tiles">
    ${HERO_TILES.map(([b, p]) => `<div class="tile"><b>${esc(b)}</b><p>${esc(p)}</p></div>`).join("\n    ")}
  </div></div>

  <section style="padding-bottom:0"><div class="wrap">
    <div class="stats">
      ${STATS.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${esc(l)}</span></div>`).join("\n      ")}
    </div>
  </div></section>

  <section id="where"><div class="wrap"><div class="band">
    <p class="eyebrow">Discord only</p>
    <h2>There is no download<br>button on this site.</h2>
    <p class="sub" style="text-align:left">Panda Tweaks is handed out through our Discord and
      nowhere else. One official file, one place to ask when something goes wrong, and no
      reuploads on some download portal with an installer bolted onto them. It is free either
      way — joining is the whole price.</p>
    <a class="btn btn--dc btn--lg" href="${esc(CONFIG.discord)}" target="_blank" rel="noopener">Open the Discord</a>
    <p class="handle">${esc(CONFIG.discord.replace(/^https?:\/\//, ""))}</p>
  </div></div></section>

  <section id="features" style="padding-top:0"><div class="wrap">
    <p class="eyebrow">What is inside</p>
    <h2>One button if that is all you want.<br>Every switch if it is not.</h2>
    <p class="sub">The analysis covers the single-click case. Anyone who wants more gets every
      change individually — searchable, risk-labelled, and with the exact place it takes effect.</p>
    <div class="grid">
      ${FEATURES.map(([i, h3, p]) => `<div class="card"><span class="ico">${i}</span><h3>${esc(h3)}</h3><p>${esc(p)}</p></div>`).join("\n      ")}
    </div>
  </div></section>

  <section id="analysis" style="padding-top:0"><div class="wrap">
    <p class="eyebrow">Relevance, not volume</p>
    <h2>It also tells you<br>what it left out.</h2>
    <p class="sub">Other tools advertise a thousand tweaks and get there by counting every registry
      value separately. The more useful question is which of them change anything on your machine —
      and why the rest was skipped.</p>
    <div class="split">
      <div class="panel">
        <h3>Suggested</h3>
        <ul>${RECOMMENDED_EXAMPLES.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>
      <div class="panel dim">
        <h3 class="dim">Skipped — and why</h3>
        <ul>${SKIPPED_EXAMPLES.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>
    </div>
  </div></section>

  <section id="catalogue" style="padding-top:0"><div class="wrap">
    <p class="eyebrow">Full control</p>
    <h2>${items.length} entries, every one explained</h2>
    <p class="sub">No hidden scripts. This is the same list the app uses — generated from the same
      data, so it cannot drift away from it. Under every entry is exactly what gets touched.</p>

    <div class="tools">
      <input type="search" id="q" placeholder="Search — name, description or registry key…" aria-label="Search">
      <select id="g" aria-label="Area">
        <option value="">All areas</option>
        ${groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("\n        ")}
      </select>
      <select id="r" aria-label="Risk">
        <option value="">Any risk</option>
        <option value="safe">Safe</option>
        <option value="advanced">Advanced</option>
        <option value="risky">Risky</option>
      </select>
    </div>

    <p class="count" id="count"></p>
    <div class="list" id="list">
      ${items.map(itemHtml).join("")}
      <div class="empty" id="empty" hidden>Nothing found.</div>
    </div>

    <div class="legend">
      ${RISK_LEGEND.map(
          ([k, label, text]) =>
              `<div class="card"><span class="badge badge--${k}">${esc(label)}</span>
        <p style="margin-top:12px">${esc(text)}</p></div>`
      ).join("\n      ")}
    </div>
  </div></section>

  <section id="safety" style="padding-top:0"><div class="wrap">
    <p class="eyebrow">Safety</p>
    <h2>What it is allowed to do —<br>and what it deliberately is not.</h2>
    <div class="grid">
      <div class="card"><h3>Starts without admin rights</h3>
        <p>Analysis and every change inside your own user account run as a normal user.
           Administrator rights are only requested when you apply something that needs them.</p></div>
      <div class="card"><h3>Restore point</h3>
        <p>On first launch the app offers a Windows restore point — and then checks whether it
           was actually created.</p></div>
      <div class="card"><h3>Risky is off by default</h3>
        <p>${riskyCount} changes count as risky. They stay hidden until you switch them on in the
           settings, and they are never recommended automatically.</p></div>
      <div class="card"><h3>System-critical is blocked</h3>
        <p>The debloater has a hard block list. Packages Windows depends on cannot be selected
           through the interface at all.</p></div>
    </div>

    <div class="honest" style="margin-top:24px">
      <h3>The honest part: ${pending.length} tweaks are still missing</h3>
      <p>The collection was imported as raw command
         line. ${pending.length} of them — powershell, powercfg, bcdedit, netsh — have not been
         translated into validated operations yet. They are marked unavailable inside the app and
         appear neither in the number above nor in the list. Better one tweak fewer than one that
         only pretends.</p>
    </div>
  </div></section>

  <section id="start" style="padding-top:0"><div class="wrap">
    <p class="eyebrow">Getting started</p>
    <h2>Running in about a minute</h2>
    <div class="steps">
      ${STEPS.map(([h3, p]) => `<div class="step"><h3>${esc(h3)}</h3><p>${esc(p)}</p></div>`).join("\n      ")}
    </div>
  </div></section>

  <section id="discord" style="padding-top:0"><div class="wrap"><div class="band">
    <p class="eyebrow">Community</p>
    <h2>Help, updates and<br>the source code</h2>
    <p class="sub" style="text-align:left">Discord is the fastest way to an answer — and new
      releases land there first.</p>
    <div class="dcgrid">
      ${DISCORD_TILES.map(([i, b, p]) => `<div><span class="ico">${i}</span><b>${esc(b)}</b><p>${esc(p)}</p></div>`).join("\n      ")}
    </div>
    <a class="btn btn--dc btn--lg" href="${esc(CONFIG.discord)}" target="_blank" rel="noopener">Join the Discord</a>
    <p class="handle">${esc(CONFIG.discord.replace(/^https?:\/\//, ""))}</p>
  </div></div></section>

  <section id="faq" style="padding-top:0"><div class="wrap">
    <p class="eyebrow">Questions</p>
    <h2>Straight answers</h2>
    <div style="margin-top:36px">
      ${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("\n      ")}
    </div>
  </div></section>

</main>

<footer>
  <div class="wrap foot">
    <span>Panda Tweaks ${esc(pkg.version)} · MIT licensed</span>
    <a class="sp" href="${esc(CONFIG.discord)}" target="_blank" rel="noopener">${esc(CONFIG.discord.replace(/^https?:\/\//, ""))}</a>
  </div>
</footer>

<script>
(function(){
  var q=document.getElementById('q'),g=document.getElementById('g'),r=document.getElementById('r'),
      count=document.getElementById('count'),empty=document.getElementById('empty'),
      items=[].slice.call(document.querySelectorAll('.item'));
  function apply(){
    var s=q.value.trim().toLowerCase(),gv=g.value,rv=r.value,n=0;
    items.forEach(function(el){
      var ok=(!s||el.dataset.search.indexOf(s)>-1)&&(!gv||el.dataset.group===gv)&&(!rv||el.dataset.risk===rv);
      el.hidden=!ok; if(ok)n++;
    });
    empty.hidden=n>0;
    count.textContent=n+' of '+items.length+' entries';
  }
  q.addEventListener('input',apply); g.addEventListener('change',apply); r.addEventListener('change',apply);
  apply();
})();
</script>

</body>
</html>
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "index.html"), html, "utf8");

const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
console.log(`site/index.html written — ${kb} KB`);
console.log(`  ${working.length} tweaks listed, ${pending.length} held back as unsupported`);
console.log(`  ${fixes.length} fixes · ${debloat.length} apps · ${services.length} services · ${items.length} rows total`);
if (CONFIG.discord.includes("CHANGE-ME")) console.log("  ! Discord invite is still a placeholder - edit CONFIG in this file");
