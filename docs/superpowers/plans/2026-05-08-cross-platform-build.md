# Cross-Platform Build & Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm install`, `npm start`, and `npm run dist` work correctly on both macOS and Windows from a shared OneDrive-synced git repo.

**Architecture:** Four targeted changes — update `.gitignore` to stop binary sync, write a Node.js cross-platform launcher (`scripts/start.js`), write a machine-specific setup script (`scripts/setup.js`), and add `electron-builder` for packaging. No changes to app source code.

**Tech Stack:** Node.js (scripts), `@electron/rebuild` (replaces `electron-rebuild`), `electron-builder` (new — packaging), TypeScript + Jest (existing test setup)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `.gitignore` | Modify | Exclude `app/node_modules/`, `app/dist/`, `app/release/`, `app/.npmrc` |
| `app/scripts/setup.js` | Create | Writes machine-specific `.npmrc` based on platform |
| `app/scripts/start.js` | Create | Cross-platform Electron launcher (Darwin 25+ vs others) |
| `app/package.json` | Modify | Update `start` script, add `setup`/`pack`/`dist` scripts, replace `electron-rebuild` with `@electron/rebuild`, add `electron-builder`, add `"build"` config block |
| `app/tests/setup-script.test.ts` | Create | Unit tests for `getNpmrcContent` |
| `app/tests/start-script.test.ts` | Create | Unit tests for `isDarwin25Plus` |

---

### Task 1: Update `.gitignore` and untrack `.npmrc`

**Files:**
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Add exclusions to `.gitignore`**

Open `.gitignore` at the repo root and append these lines:

```
app/node_modules/
app/dist/
app/release/
app/.npmrc
```

The full `.gitignore` should now be:
```
.pio
.vscode/.browse.c_cpp.db*
.vscode/c_cpp_properties.json
.vscode/launch.json
.vscode/ipch
app/node_modules/
app/dist/
app/release/
app/.npmrc
```

- [ ] **Step 2: Remove `.npmrc` from git tracking (keep file on disk)**

```bash
cd /path/to/repo   # the repo root, not app/
git rm --cached app/.npmrc
```

Expected output:
```
rm 'app/.npmrc'
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: exclude platform-specific build artifacts and .npmrc from git"
```

---

### Task 2: Write `scripts/setup.js` with unit tests

**Files:**
- Create: `app/scripts/setup.js`
- Create: `app/tests/setup-script.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/tests/setup-script.test.ts`:

```typescript
const setup = require('../scripts/setup');

describe('getNpmrcContent', () => {
  test('returns python path on darwin', () => {
    expect(setup.getNpmrcContent('darwin')).toBe('python=/opt/homebrew/bin/python3.11\n');
  });

  test('returns empty string on win32', () => {
    expect(setup.getNpmrcContent('win32')).toBe('');
  });

  test('returns empty string on linux', () => {
    expect(setup.getNpmrcContent('linux')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd app
npm test -- --testPathPattern=setup-script
```

Expected: FAIL — `Cannot find module '../scripts/setup'`

- [ ] **Step 3: Create `app/scripts/` directory and write `setup.js`**

```bash
mkdir -p app/scripts
```

Create `app/scripts/setup.js`:

```js
const path = require('path');
const fs = require('fs');

function getNpmrcContent(platform) {
  if (platform === 'darwin') {
    return 'python=/opt/homebrew/bin/python3.11\n';
  }
  return '';
}

function main() {
  const content = getNpmrcContent(process.platform);
  const npmrcPath = path.join(__dirname, '..', '.npmrc');
  if (content) {
    fs.writeFileSync(npmrcPath, content, 'utf8');
    console.log(`Wrote .npmrc for ${process.platform}: ${npmrcPath}`);
  } else {
    console.log(`No .npmrc config needed for ${process.platform}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getNpmrcContent };
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd app
npm test -- --testPathPattern=setup-script
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add app/scripts/setup.js app/tests/setup-script.test.ts
git commit -m "feat: add platform-specific .npmrc setup script"
```

---

### Task 3: Write `scripts/start.js` with unit tests

**Files:**
- Create: `app/scripts/start.js`
- Create: `app/tests/start-script.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/tests/start-script.test.ts`:

```typescript
const startScript = require('../scripts/start');

describe('isDarwin25Plus', () => {
  test('returns true for Darwin 25', () => {
    expect(startScript.isDarwin25Plus('darwin', '25.3.0')).toBe(true);
  });

  test('returns true for Darwin 26', () => {
    expect(startScript.isDarwin25Plus('darwin', '26.0.0')).toBe(true);
  });

  test('returns false for Darwin 24', () => {
    expect(startScript.isDarwin25Plus('darwin', '24.6.0')).toBe(false);
  });

  test('returns false for win32 regardless of version', () => {
    expect(startScript.isDarwin25Plus('win32', '25.0.0')).toBe(false);
  });

  test('returns false for linux', () => {
    expect(startScript.isDarwin25Plus('linux', '25.0.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd app
npm test -- --testPathPattern=start-script
```

Expected: FAIL — `Cannot find module '../scripts/start'`

- [ ] **Step 3: Create `app/scripts/start.js`**

Create `app/scripts/start.js`:

```js
const path = require('path');
const os = require('os');

function isDarwin25Plus(platform, release) {
  return platform === 'darwin' && parseInt(release.split('.')[0], 10) >= 25;
}

function main() {
  const { execFileSync } = require('child_process');
  const electronBin = require('electron');
  const cwd = path.resolve(__dirname, '..');

  if (isDarwin25Plus(process.platform, os.release())) {
    const appPath = path.join(cwd, 'node_modules/electron/dist/Electron.app');
    execFileSync('open', ['-n', '-W', appPath, '--args', cwd], { stdio: 'inherit' });
  } else {
    execFileSync(String(electronBin), [cwd], { stdio: 'inherit' });
  }
}

if (require.main === module) {
  main();
}

module.exports = { isDarwin25Plus };
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd app
npm test -- --testPathPattern=start-script
```

Expected: PASS — 5 tests passing

- [ ] **Step 5: Confirm all existing tests still pass**

```bash
cd app
npm test
```

Expected: All test suites pass.

- [ ] **Step 6: Commit**

```bash
git add app/scripts/start.js app/tests/start-script.test.ts
git commit -m "feat: add cross-platform Electron launcher script"
```

---

### Task 4: Update `package.json`

**Files:**
- Modify: `app/package.json`

- [ ] **Step 1: Replace the full `package.json` with the updated version**

`app/package.json`:

```json
{
  "name": "cando",
  "version": "1.0.0",
  "main": "dist/main.js",
  "scripts": {
    "setup": "node scripts/setup.js",
    "build": "tsc",
    "start": "npm run build && node scripts/start.js",
    "test": "jest",
    "pack": "npm run build && electron-builder --dir",
    "dist": "npm run build && electron-builder",
    "postinstall": "electron-rebuild"
  },
  "build": {
    "appId": "com.cando.app",
    "productName": "CANdo",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**/*",
      "index.html",
      "styles.css",
      "polyfill.js"
    ],
    "mac": {
      "target": "dmg"
    },
    "win": {
      "target": "nsis"
    }
  },
  "dependencies": {
    "serialport": "^12.0.0"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.7.0",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.12.12",
    "electron": "^42.0.0",
    "electron-builder": "^25.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.4",
    "typescript": "^5.4.5"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "roots": [
      "<rootDir>/tests"
    ]
  }
}
```

Key changes from previous version:
- `start` → `npm run build && node scripts/start.js`
- Added `setup`, `pack`, `dist` scripts
- Removed `electron-rebuild`, added `@electron/rebuild` and `electron-builder`
- Added `"build"` config block with `"directories": { "output": "release" }` to avoid conflicting with `tsc` output in `dist/`

- [ ] **Step 2: Run setup to write platform-specific `.npmrc`**

```bash
cd app
npm run setup
```

Expected on macOS:
```
Wrote .npmrc for darwin: /path/to/app/.npmrc
```

Expected on Windows:
```
No .npmrc config needed for win32
```

- [ ] **Step 3: Install updated dependencies**

```bash
npm install
```

Expected: Installs `@electron/rebuild`, `electron-builder`, runs `electron-rebuild` postinstall successfully (no errors).

- [ ] **Step 4: Run all tests to confirm nothing broke**

```bash
npm test
```

Expected: All test suites pass (protocol, logger, serial, canDefinitions, transmit, setup-script, start-script).

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json
git commit -m "feat: cross-platform scripts, electron-builder, @electron/rebuild"
```

---

### Task 5: Smoke test build and launch

**Files:** None

- [ ] **Step 1: Verify `npm start` opens the app**

```bash
cd app
npm start
```

Expected: TypeScript compiles without errors, Electron window opens showing the CANdo UI.

- [ ] **Step 2: Verify `npm run pack` produces an unpacked app**

```bash
npm run pack
```

Expected on macOS: creates `app/release/mac/CANdo.app`
Expected on Windows: creates `app/release/win-unpacked/CANdo.exe`

No errors during packaging.

- [ ] **Step 3: Verify the packed app launches**

macOS:
```bash
open app/release/mac/CANdo.app
```

Windows: double-click `app\release\win-unpacked\CANdo.exe`

Expected: App opens and shows the CANdo UI.

- [ ] **Step 4: Commit any lockfile changes from install**

```bash
cd ..  # repo root
git status
```

If `app/package-lock.json` shows changes (from the pack step updating it), commit them:

```bash
git add app/package-lock.json
git commit -m "chore: update lockfile after electron-builder install"
```

---

## Setup Instructions for a New Machine

After cloning or syncing the repo on a new machine, run:

```bash
cd app
npm run setup    # writes .npmrc for this platform (macOS only)
npm install      # installs deps and rebuilds native modules
npm start        # build + launch
```

**Prerequisites:**
- macOS: Homebrew Python 3.11 (`brew install python@3.11`), Xcode app with `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
- Windows: Python 3.x in PATH, Visual Studio Build Tools (C++ workload)
