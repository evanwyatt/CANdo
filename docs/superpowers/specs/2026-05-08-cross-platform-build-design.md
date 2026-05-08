# Cross-Platform Build & Launch — Design Spec
**Date:** 2026-05-08
**Status:** Approved

## Problem

The project lives in an OneDrive-synced folder shared between a macOS machine and a Windows machine. Because `node_modules` and `dist` were not excluded from sync, platform-specific binaries (Electron, serialport native module) were syncing across machines, causing silent launch failures and build errors. Additionally, the `start` script was macOS-only, and no distribution packaging existed.

## Goals

1. `npm install` + `npm start` works independently on both macOS and Windows after a fresh clone/sync.
2. `npm run dist` produces a platform-native installer (`.dmg` on macOS, `.exe` on Windows).

## Non-goals

- Cross-compilation (building a Windows installer from macOS or vice versa)
- CI/CD automation
- Auto-update infrastructure
- Code signing

---

## Design

### 1. `.gitignore` — prevent OneDrive binary sync

Add to `.gitignore`:

```
app/node_modules/
app/dist/
app/.npmrc
```

`node_modules` is platform-specific binary code and must never sync between machines. `dist` is compiled output, reproducible from source. `.npmrc` is machine-specific config (see Section 3).

After this change, first-time setup on any machine is: `npm run setup && npm install`.

---

### 2. Cross-platform `start` script

**Problem:** The current `start` script uses `open -n -W "...Electron.app" --args "$PWD"`, which is macOS-only. On Darwin 25+ (macOS 26) this is required because direct Electron binary invocation fails with `icudtl.dat not found`. On older macOS and Windows, plain `electron .` works.

**Solution:** A Node.js launcher at `app/scripts/start.js`:

```js
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const electronBin = require('electron');
const cwd = path.resolve(__dirname, '..');

const isDarwin25Plus = process.platform === 'darwin' &&
  parseInt(os.release().split('.')[0], 10) >= 25;

if (isDarwin25Plus) {
  const appPath = path.join(cwd, 'node_modules/electron/dist/Electron.app');
  execFileSync('open', ['-n', '-W', appPath, '--args', cwd], { stdio: 'inherit' });
} else {
  execFileSync(electronBin, [cwd], { stdio: 'inherit' });
}
```

`package.json` `start` script becomes:
```json
"start": "npm run build && node scripts/start.js"
```

---

### 3. `electron-rebuild` → `@electron/rebuild` + Python config

**Rebuilder upgrade:** Replace `electron-rebuild@3.2.9` with `@electron/rebuild`. This is the maintained successor with the same CLI API and a newer `node-gyp` that handles modern toolchains better. `postinstall` stays `electron-rebuild`.

**Python config:** On macOS, Python 3.14 (the system default) removed `distutils`, which node-gyp requires to compile `@serialport/bindings-cpp`. Python 3.11 must be used. On Windows, the default Python installation works without override.

Because the required Python path differs per machine, `.npmrc` is machine-specific and must not be committed. Instead:

- `.npmrc` is added to `.gitignore`
- A setup script at `app/scripts/setup.js` writes the correct `.npmrc` for the current platform
- New `package.json` script: `"setup": "node scripts/setup.js"`

`setup.js` logic:
- **macOS:** writes `python=/opt/homebrew/bin/python3.11` to `app/.npmrc`. Requires Homebrew Python 3.11 (`brew install python@3.11`).
- **Windows:** writes nothing — assumes Python is in PATH and compatible with node-gyp.

**First-time setup (both platforms):**
```sh
cd app
npm run setup   # writes .npmrc if needed
npm install
npm start
```

---

### 4. `electron-builder` for distribution

Add `electron-builder` as a dev dependency. Configuration lives in `package.json` under the `"build"` key:

```json
"build": {
  "appId": "com.cando.app",
  "productName": "CANdo",
  "files": [
    "dist/**/*",
    "index.html",
    "styles.css",
    "polyfill.js"
  ],
  "mac": { "target": "dmg" },
  "win": { "target": "nsis" }
}
```

New `package.json` scripts:
```json
"pack": "npm run build && electron-builder --dir",
"dist": "npm run build && electron-builder"
```

- `npm run pack` — builds an unpacked app folder, fast for smoke-testing
- `npm run dist` — produces the platform installer

Each platform builds its own installer. Run on macOS for `.dmg`, run on Windows for `.exe`.

---

## File Changes Summary

| File | Change |
|------|--------|
| `.gitignore` | Add `app/node_modules/`, `app/dist/`, `app/.npmrc` |
| `app/package.json` | Update `start`, add `setup`/`pack`/`dist` scripts, replace `electron-rebuild` with `@electron/rebuild`, add `electron-builder`, add `"build"` config block |
| `app/scripts/start.js` | New — cross-platform Electron launcher |
| `app/scripts/setup.js` | New — writes machine-specific `.npmrc` |
| `app/.npmrc` | Removed from git (machine-local only) |

## Setup Instructions (per machine, after cloning)

```sh
cd app
npm run setup    # writes .npmrc for this platform if needed
npm install      # installs deps and rebuilds native modules
npm start        # build + launch
```

## Prerequisites

| Platform | Requirement |
|----------|-------------|
| macOS | Homebrew Python 3.11 (`brew install python@3.11`), Xcode (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`) |
| Windows | Python 3.x in PATH, Visual Studio Build Tools |
