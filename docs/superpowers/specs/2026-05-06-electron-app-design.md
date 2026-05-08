# CANdo Electron App — Design Spec
**Date:** 2026-05-06

## Overview

An Electron desktop app for macOS and Windows that communicates with the CANable 2.0 Pro firmware over USB CDC serial. Users can select the serial port, set CAN bus speed, open/close the channel, view decoded CAN frames in real time, and record sessions to CSV.

## Use Cases

- **Debugging / development**: viewing raw frames while building something on a CAN bus
- **Monitoring**: watching a live system over time, recording for later analysis

---

## Architecture

**Pattern:** Main process owns all I/O; renderer is pure UI.

- `main.ts` — Electron entry point, IPC handlers, wires serial/logger together
- `preload.ts` — `contextBridge` exposes a narrow typed `window.api` to the renderer
- `renderer.ts` — all UI logic, dedup, filtering, table rendering
- `index.html` — single window shell
- `styles.css` — dark/terminal theme
- `src/serial.ts` — `SerialPort` wrapper, buffer accumulation, command queue
- `src/protocol.ts` — COBS decode, frame unpack, shared types
- `src/logger.ts` — CSV file logging

```
app/
  main.ts
  preload.ts
  renderer.ts
  index.html
  styles.css
  tsconfig.json
  package.json
  src/
    serial.ts
    protocol.ts
    logger.ts
  dist/              ← compiled output (gitignored)
```

---

## Shared Types (`src/protocol.ts`)

```ts
interface CanFrame {
  seq:  number;       // incrementing counter (total frames received)
  ts:   number;       // ms since channel open
  id:   number;       // CAN identifier
  ext:  boolean;      // extended (29-bit) ID
  rtr:  boolean;      // remote transmission request
  dlc:  number;       // payload byte count (0–8)
  data: Uint8Array;
}

interface PortInfo {
  path:         string;
  manufacturer: string | undefined;
}

type SpeedIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface AppStatus {
  connected:  boolean;
  channelOpen: boolean;
  recording:  boolean;
  recordPath: string | null;
  errorCount: number;
}
```

---

## Serial Layer (`src/serial.ts`)

- Wraps `SerialPort` as an `EventEmitter`
- Accumulates bytes in a `Buffer`, splits on:
  - `0x00` → COBS frame → decoded and emitted as `CanFrame`
  - `0x0A` (`\n`) → command response (`OK` or `KO`) → resolves oldest pending command promise
- Commands are queued; each times out after 2 seconds if no response
- Emits `close` event on unexpected disconnect

---

## Logger (`src/logger.ts`)

- `startLogging(path: string): void` — opens a CSV write stream, writes header row:
  ```
  seq,ts_ms,id_hex,ext,rtr,dlc,data_hex
  ```
- `appendFrame(frame: CanFrame): void` — writes one row per frame (every frame, regardless of display dedup)
- `stopLogging(): void` — flushes and closes the stream
- On write error: emits an error event; main process relays to renderer as a toast

---

## IPC API (`preload.ts`)

```ts
interface CanDoAPI {
  listPorts():                         Promise<PortInfo[]>
  connect(path: string):               Promise<void>
  disconnect():                        Promise<void>
  setSpeed(index: SpeedIndex):         Promise<'OK' | 'KO'>
  openChannel():                       Promise<'OK' | 'KO'>
  closeChannel():                      Promise<'OK' | 'KO'>
  startLogging():                      Promise<string>   // opens save dialog, returns path
  stopLogging():                       Promise<void>
  onFrame(cb: (frame: CanFrame) => void):       void
  onStatus(cb: (status: AppStatus) => void):    void
}
```

---

## UI Layout

### Visual style
Dark/terminal theme: `#0d1117` background, monospace font, green/blue/amber/red accents.

### Top bar (left → right)
`PORT` label → port dropdown → refresh button → divider → `SPEED` label → speed dropdown → divider → Connect/Disconnect button → Open/Close button → divider → Record button → spacer → frame count → Clear button

### Filter bar (below top bar)
Live text search input (matches on ID hex or data hex) + `ID List…` button opening a modal to manage a CAN ID filter list. The modal has a mode toggle: **Allowlist** (show only listed IDs) or **Blocklist** (hide listed IDs). IDs are entered as hex, one per line. Shows `showing N / total` count in the filter bar.

### Frame log table
Columns: `#` · `LAST SEEN` · `ID` · `FLAGS` · `DLC` · `COUNT` · `DATA`

- Monospace, alternating subtle row shading
- EXT frames: blue; RTR frames: red; standard frames: green
- **Deduplication**: two frames are identical if ID + flags + DLC + data all match. On match: COUNT increments, LAST SEEN updates in place — no new row added.
- COUNT column: plain number; green-highlighted badge when > 1, muted grey at 1
- Auto-scrolls to bottom; pauses if user scrolls up; resumes when user scrolls back to bottom
- Capped at 2000 unique rows; oldest removed when exceeded

### Status bar (bottom)
Connection state · channel state · speed · spacer · recording indicator (filename, red when active)

---

## Speed Options

| Display       | Command | Actual rate   |
|---------------|---------|---------------|
| 1.000 Mbps    | S1      | 1.000 Mbps    |
| 2.000 Mbps    | S2      | 2.000 Mbps    |
| ~3.0 Mbps     | S3      | 3.048 Mbps    |
| 4.000 Mbps    | S4      | 4.000 Mbps    |
| ~4.9 Mbps     | S5      | 4.923 Mbps    |
| ~5.8 Mbps     | S6      | 5.818 Mbps    |
| ~7.1 Mbps     | S7      | 7.111 Mbps    |
| 8.000 Mbps    | S8      | 8.000 Mbps    |

The command code (S1–S8) is not shown in the UI.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| USB unplug while connected | `serial.ts` emits `close`; UI shows "Disconnected", disables Open/Record. Reconnect is manual. |
| Command timeout (2s, no OK/KO) | Promise rejects; brief error toast; button re-enabled |
| COBS decode failure | Frame silently dropped; `errorCount` increments; status bar shows `Errors: N` |
| CSV write failure | Recording stops; error toast with OS error message |
| Speed change while channel open | Firmware stops/re-inits/restarts automatically; UI disables log during flight, re-enables on OK |
| Frame log overflow (>2000 rows) | Oldest rows removed; total frame counter (status bar) is never truncated |

---

## Build & Run

```sh
cd app
npm install          # electron-rebuild runs automatically via postinstall
npm start            # tsc + electron .
```

TypeScript compiles to `dist/`, Electron loads from there. `.gitignore` includes `dist/` and `node_modules/`.

---

## Future Features (Not In Current Scope)

### Packet Decoder / Signal Definitions

Allow users to define a signal map for a given CAN ID that describes how to interpret the payload bytes:

- Each definition has a CAN ID, a name, and a list of fields: `{ name, startByte, length, type, byteOrder }`
- Types: `uint8`, `uint16`, `uint32`, `int8`, `int16`, `int32`, `float32`
- Byte order: big-endian or little-endian per field
- When a frame matches a definition, the DATA column expands to show decoded field values inline (e.g. `speed: 42.5  rpm: 1200`)
- Definitions stored as JSON in a user-configurable file or in app localStorage
- Modal UI similar to the ID list modal for managing definitions

### Packet Transmitter

Allow users to compose and send CAN frames from the app:

- UI panel with: CAN ID (hex), EXT toggle, RTR toggle, DLC, data bytes (hex)
- **Repeat mode**: checkbox + interval field (ms) — sends the frame on a timer until stopped
- **Delay**: optional one-shot delay before first send (ms)
- Firmware side: needs a TX command added to the serial protocol (e.g. `T<id>,<flags>,<dlc>,<data_hex>\n`)
- Multiple transmit slots (e.g. up to 8 scheduled frames) so the user can simulate multiple nodes
- Transmitted frames appear in the frame log with a distinct color/marker
