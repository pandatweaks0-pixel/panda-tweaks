# Panda Tweaks

A free Windows tweaking and debloat utility that shows you exactly what it
changes — and can put it back.

No telemetry, no account, no network calls. Everything stays on your PC.

---

## What it does

- **Analyses your system first.** Windows version, hardware, security state,
  privacy settings, startup entries, services, scheduled tasks and preinstalled
  apps. The analysis is strictly read-only.
- **Scores five areas** — Performance, Privacy, Debloat, Gaming, Security — and
  shows every individual check that produced the number.
- **Recommends tweaks based on what it actually found**, not a fixed list. Each
  recommendation states why it applies to your machine.
- **Shows the exact change before applying it**: the registry key, the service,
  the scheduled task. There are no hidden commands.
- **Real undo.** Applying a tweak snapshots the current state; undoing replays
  that snapshot. If your `MenuShowDelay` was `200`, undo gives you `200` back —
  not the Windows default of `400`.
- **Debloat from what you actually have.** The list is enumerated from the
  machine, not from a fixed catalogue, and grouped into preinstalled apps,
  things you installed, and the runtimes and codecs you should keep. Every app
  is named the way Windows names it — `Microsoft.ScreenSketch` is shown as
  Snipping Tool, because a row nobody can identify is a row nobody can decide
  about. A hard blocklist marks packages that can never be removed, and a
  softer "better kept" mark warns before the ones people rely on.
- **Autostart** — everything that starts with Windows, with the command each
  entry actually runs. Switching one off writes the same approval marker Task
  Manager writes: the Run value and the shortcut stay, so it can be undone.
- **Services** — curated Windows services that can be turned off, with the same
  undo as any other change.
- **Fixes** — one-press repairs for common Windows problems, including ones a
  tweak caused. Each puts default behaviour back and is never pre-selected.
- **Game presets** — named bundles of tweaks. A preset states how many of its
  tweaks actually apply on your machine rather than promising all of them.
- **Cleanup** — temp folders and caches, measured before you decide. A folder
  that cannot be read says so instead of reporting zero.
- **English and German**, five themes, and an accent colour.

---

## Installation

Download the portable `.exe` or the installer from the releases page, and run
it. Nothing is installed system-wide by the portable build.

Panda Tweaks **starts without administrator rights on purpose**. It asks for
elevation only when a change genuinely needs it — every `HKCU` tweak, the whole
analysis and Store app removal work fine as a standard user.

---

## Build it yourself

Requires [Node.js](https://nodejs.org) LTS.

```bash
npm install
npm start
```

Build distributables:

```bash
npm run build         # portable .exe   -> dist/
npm run build:setup   # NSIS installer  -> dist/
npm run build:all     # both
```

Run the tests:

```bash
npm test
```

Regenerate the app icon:

```bash
node tools/make-icon.js
```

---

## Architecture

```
src/
  main/                  Electron main process (Node, has system access)
    main.js              window + lifecycle
    ipc.js               the complete renderer-facing API surface
    preload.js           contextBridge; one typed function per IPC channel
    ops.js               typed operations: registry, service, task, appx, cleanup
    engine.js            detect / apply / undo, history store
    analyzer.js          system analysis + recommendations
    scores.js            health scoring (pure, no I/O)
    restore.js           restore points, with verification
    elevation.js         admin detection and on-demand UAC relaunch
    settings.js          user settings
    logger.js            local append-only log
    shell.js             process helpers (execFile only, never a shell string)
    ps/                  fixed PowerShell scripts, one per read
  renderer/              UI (no Node access)
    index.html app.css
    splash.js i18n.js ui.js views.js app.js
  data/
    tweaks.json          the tweak catalogue
    debloat.json         names and recommendations for known Store apps
    services.json        curated services, loaded as one-operation tweaks
    fixes.json           repairs, as typed operations rather than commands
    presets.json         game presets: named lists of tweak ids
    locales/en.json de.json
test/                    node:test, no framework
tools/                   converter and icon generator
```

**The main/renderer split is the security boundary.** The renderer has
`nodeIntegration: false`, `contextIsolation: true` and a Content-Security-Policy
that blocks everything except the app's own files. It can only reach the main
process through the channels listed in `preload.js`.

---

## Security model

**There is no generic command execution.** The renderer cannot ask the main
process to run a command; it can only invoke a typed operation with structured
arguments, which the main process validates before touching anything. This
matters because the process may be running elevated.

Every operation type declares:

| | |
|---|---|
| `capture(ops)` | read the current state (batched — one process, not one per value) |
| `isApplied(op, current)` | is the desired state already in place? `null` means "could not read" |
| `apply(op)` | make the change |
| `restore(op, previous)` | put the captured state back |
| `describe(op)` | the exact target, in plain text, shown before anything runs |

Further rules the code enforces:

- **Nothing is downloaded or executed from the internet.** No `iex (irm ...)`,
  no remote scripts, no update fetches.
- **Repairs choose from a fixed table, they do not carry a command.** A
  `command` operation names an entry in a table inside `ops.js`; the executable
  and its arguments live there as an argv array. A data file — and therefore
  anything the renderer can reach — can only pick an id. There is still no path
  by which a string becomes a command line, which is the property that matters
  while the process may be elevated.
- **No shell strings.** Everything goes through `execFile` with an argument
  array, so a value containing `&` or `;` is inert.
- **PowerShell scripts are fixed files.** Data reaches them as a temp JSON file
  whose path is passed in an environment variable — never spliced into script
  source.
- **A failed read is never treated as "absent".** That distinction is what stops
  an undo from deleting a value that was actually there.
- **Security features are never disabled by default.** Tweaks touching Defender,
  the firewall, UAC or memory integrity are classified `risky`, hidden unless you
  enable them, never auto-recommended, and warn before running.
- **System-critical Store packages cannot be removed**, regardless of what the
  data files say — the blocklist lives in `ops.js`.

---

## The tweak system

A tweak is data, not code. Adding one means adding an entry to
`src/data/tweaks.json`:

```json
{
  "id": "win_show_ext",
  "name": "Show File Extensions",
  "category": "Windows",
  "risk": "safe",
  "description": "Always show file extensions in Explorer.",
  "recommended": true,
  "requiresRestart": false,
  "operations": [
    {
      "type": "registry",
      "action": "set",
      "hive": "HKCU",
      "key": "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
      "name": "HideFileExt",
      "valueType": "REG_DWORD",
      "value": "0"
    }
  ]
}
```

Detection, application, undo, logging and the "what this changes" list are all
derived from the operations. You do not write any of that per tweak.

**Operation types:** `registry`, `service`, `scheduledTask`, `appx`, `startup`,
`cleanup`, `command`.

Services and cleanup targets are not a separate system: each is generated at
load time as a tweak with a single operation, so detection, undo, history and
the "what this changes" dialog apply to them unchanged. Cleanup declares
`detectable: false`, which keeps its directory walk out of every system scan —
the cleanup page asks for those readings by name and reports real sizes.

**Risk levels:**

| Level | Meaning |
|---|---|
| `safe` | Very low risk, reversible, does not change how Windows works. Pre-selected. |
| `advanced` | Changes system behaviour. Reversible. Opt-in. |
| `risky` | Can weaken security or break features. Hidden by default, never recommended, always warns. |

A tweak whose definition cannot be validated stays visible in the list, marked
unavailable with the reason — it is never silently dropped, and never silently
half-applied.

### Not implemented yet

The catalogue includes tweaks whose original commands used `powercfg`, `netsh`,
`bcdedit` or ad-hoc PowerShell. Those have no typed operation yet, so they ship
**disabled and labelled**, with the original command preserved in the JSON.

They are not hidden and they are not faked. A tweak either performs a defined,
reversible action or says it cannot.

---

## Rollback

Applying a tweak:

1. Read the current state of every value the tweak touches.
2. Write a history entry containing that snapshot.
3. Apply the operations, one at a time. One failure never aborts the batch.
4. Read the values back. A write that reported success but did not stick is
   recorded as `unverified`, not as success.

Undoing replays the snapshot in reverse order:

- **Registry** — restores the previous value with its original type. If the value
  did not exist before, undo *deletes* it rather than writing an assumed default.
- **Services** — restores the previous start type, and restarts the service if it
  had been running.
- **Scheduled tasks** — restores the previous enabled state.
- **Store apps** — removal is per-user, which leaves the package files on disk.
  Undo re-registers the app from there: no download, no Store, no account. That
  needs administrator rights, and it only works while Windows still has the
  files, so the attempt reports which of those it hit instead of promising a
  clean revert. If the payload is gone, the Store is the only way back.
- **Cleanup** — not undoable, and presented as a one-time action with a "Run"
  button rather than a toggle.

History lives in `history.json` in the app data folder, so it survives restarts.

---

## Restore points

Panda Tweaks offers a Windows System Restore Point on first run and before
applying a batch.

`Checkpoint-Computer` can return without an error and still create nothing —
most commonly because Windows only creates one restore point per 24 hours. So
the app compares the restore point list before and after, and **only reports
success when a new point is actually there**. Otherwise it tells you which of
these happened:

| Reason | What it means |
|---|---|
| `created` | Verified: a new restore point exists. |
| `throttled` | Windows skipped it; a recent point already exists. |
| `protection-disabled` | System Protection is off for the drive. |
| `needs-admin` | Requires administrator rights. |

System Protection is never enabled silently — that is a system change, so it is
left to you.

---

## Files and logging

Everything lives in `%APPDATA%\Panda Tweaks`:

| File | Contents |
|---|---|
| `settings.json` | language, theme, accent, safety options |
| `history.json` | applied changes and their state snapshots |
| `analysis.json` | cached scan, so startup does not block on a fresh scan |
| `panda-tweaks.log` | timestamped record of every change, with before and after |

The log records what changed and what the value was — never anything
identifying about you, and nothing leaves the machine. It can be exported or
cleared from Settings.

---

## Licence

MIT — see [LICENSE](LICENSE). Third-party notices are in [NOTICE.md](NOTICE.md).
