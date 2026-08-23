# Third-party notices

## SlideTweaks

Panda Tweaks began as a fork of **SlideTweaks 2.1.0** (https://slidetweaks.com),
which is distributed under the MIT License. The MIT License requires that the
original copyright and permission notice be preserved in derived works — see
[LICENSE](LICENSE).

**What was carried over from SlideTweaks:**

- The tweak knowledge base — registry keys, service names and default values —
  used as the starting point for `src/data/tweaks.json`, `src/data/debloat.json`
  and `src/data/services.json`.
- The curated "safe to disable" service list and the debloat app list.
- German and English wording for a number of tweak descriptions.

**What is not from SlideTweaks:**

- The entire user interface (`src/renderer/`) — layout, styling, navigation,
  theming and branding are original to Panda Tweaks.
- The operations layer (`src/main/ops.js`), which replaces free-form shell
  command execution with typed, validated operations.
- The rollback engine (`src/main/engine.js`), which captures and restores real
  previous system state instead of replaying hardcoded revert commands.
- System analysis and health scoring (`src/main/analyzer.js`,
  `src/main/scores.js`).
- Restore point verification (`src/main/restore.js`).

## Electron

This application bundles Electron, which is distributed under the MIT License,
and Chromium, which is distributed under the BSD 3-Clause License and other
licenses. Their full license texts ship inside the packaged application.
