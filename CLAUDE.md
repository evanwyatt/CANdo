# CANdo

Electron desktop app (macOS/Windows) for communicating with a CANable 2.0 Pro over USB CDC serial. Displays decoded CAN frames in real time, logs sessions to CSV, and can transmit frames.

## Build & Run

All commands run from `app/`:

```sh
npm install        # install deps; electron-rebuild runs automatically via postinstall
npm test           # run jest unit tests
npm run build      # tsc compile → dist/
npm start          # build + electron .
```

TypeScript compiles to `dist/`; Electron loads `dist/main.js`. The `index.html` and `styles.css` live at the `app/` root (not in `dist/`).

## Architecture

Main process owns all I/O. Renderer is pure UI. They communicate through a narrow `contextBridge` IPC API.

```
app/
  main.ts           ← Electron entry, all IPC handlers, serial/logger/transmit wiring
  preload.ts        ← contextBridge: exposes window.api to renderer
  renderer.ts       ← all UI: top bar, frame table, filter, modal, transmit panel, toasts
  index.html        ← single window shell
  styles.css        ← dark/terminal theme (#0d1117 background)
  src/
    protocol.ts     ← shared types (CanFrame, AppStatus, etc.), COBS decode, frame unpack, parseBuffer
    serial.ts       ← SerialPort wrapper, byte accumulation, command queue (2s timeout)
    logger.ts       ← CSV file logging (start/append/stop), EventEmitter for errors
    transmit.ts     ← parseTransmitData, encodeTransmitCommand (T,<id>,<flags>,<dlc>,<data>)
    canDefinitions.ts ← CAN signal decoder types + decodeFrameWithDefinitions
  tests/
    protocol.test.ts
    logger.test.ts
    serial.test.ts
```

## Key Design Decisions

**Serial framing:** The device sends two frame types over a single byte stream:
- COBS frames terminated by `0x00` — decoded CAN data frames
- ASCII lines terminated by `0x0A` — command responses (`OK` or `KO`)

`parseBuffer` in `protocol.ts` scans the accumulation buffer for both delimiters on every chunk, returns the unconsumed tail, and SerialManager replaces `this.buf` with it.

**Command queue:** Commands are sent to the device as ASCII (e.g. `S1`, `O`, `C`, `T,...`). Each command is queued as a Promise; the oldest pending command resolves/rejects when `OK`/`KO` arrives. Commands time out after 2 seconds.

**Frame deduplication:** Two frames are identical if ID + flags + DLC + data all match. On match, COUNT increments and LAST SEEN updates in place — no new DOM row. Cap is 2000 unique rows; oldest removed when exceeded.

**CAN definitions:** JSON files (`CanDefinitionFile`) map CAN IDs to named signal fields. Fields can be `number` (with byte range, byte order, scale/offset/unit) or `bits` (per-bit named signals). Loaded via file dialog; active definitions are pushed to renderer via IPC on each frame.

**Transmit:** The serial protocol uses `T,<id_hex>,<flags_hex>,<dlc>,<data_hex>\n`. Repeat mode uses `setInterval` in the main process; `stopRepeat` clears it. Status tracks `repeatActive`.

## IPC API (window.api)

| Method | Direction | Description |
|--------|-----------|-------------|
| `listPorts()` | R→M | List available serial ports |
| `connect(path)` | R→M | Open serial port |
| `disconnect()` | R→M | Close channel + port |
| `setSpeed(1–8)` | R→M | Send S1–S8 speed command |
| `openChannel()` | R→M | Send O command |
| `closeChannel()` | R→M | Send C command |
| `startLogging()` | R→M | Open save dialog, start CSV |
| `stopLogging()` | R→M | Flush and close CSV |
| `transmitFrame(req)` | R→M | Send one CAN frame |
| `startRepeat(req, ms)` | R→M | Repeat-send at interval |
| `stopRepeat()` | R→M | Stop repeat timer |
| `loadDefinitions()` | R→M | File dialog → load JSON defs |
| `saveDefinitions(defs)` | R→M | Save JSON defs to file |
| `setDefinitions(defs)` | R→M | Apply loaded defs (null = clear) |
| `onFrame(cb)` | M→R | `{ frame, decoded }` per CAN frame |
| `onStatus(cb)` | M→R | AppStatus on any state change |
| `onToast(cb)` | M→R | Error strings for toast display |
| `onDefinitions(cb)` | M→R | Active CanDefinitionFile or null |

## Speed Commands

| UI Label | Command | Actual Rate |
|----------|---------|-------------|
| 1.000 Mbps | S1 | 1.000 Mbps |
| 2.000 Mbps | S2 | 2.000 Mbps |
| ~3.0 Mbps | S3 | 3.048 Mbps |
| 4.000 Mbps | S4 | 4.000 Mbps |
| ~4.9 Mbps | S5 | 4.923 Mbps |
| ~5.8 Mbps | S6 | 5.818 Mbps |
| ~7.1 Mbps | S7 | 7.111 Mbps |
| 8.000 Mbps | S8 | 8.000 Mbps |

## Hardware

Target device: **CANable 2.0 Pro** running CANable firmware. Connects as a USB CDC serial device (virtual COM port). No custom driver needed on macOS or Windows 10+.
