# CANdo Electron App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript Electron desktop app for macOS/Windows that communicates with CANable 2.0 Pro over USB CDC serial, displays decoded CAN frames in real time, and logs sessions to CSV.

**Architecture:** Main process owns all I/O (serial port, COBS decode, CSV logging); renderer is pure UI. They communicate via a narrow `contextBridge` IPC API. Serial layer accumulates bytes, splits on 0x00 (COBS frames) and 0x0A (command responses), and queues pending commands with 2s timeouts.

**Tech Stack:** Electron 28, TypeScript 5, SerialPort 12, Jest + ts-jest, electron-rebuild, Node.js 18+

---

## File Map

| File | Responsibility |
|------|---------------|
| `app/src/protocol.ts` | Shared types (CanFrame, PortInfo, SpeedIndex, AppStatus, CanDoAPI), COBS decode, frame unpack, buffer parse |
| `app/src/logger.ts` | CSV file logging (start/append/stop) |
| `app/src/serial.ts` | SerialPort wrapper, byte accumulation, command queue |
| `app/main.ts` | Electron entry point, BrowserWindow, all IPC handlers |
| `app/preload.ts` | contextBridge exposing typed `window.api` |
| `app/index.html` | Single window shell |
| `app/styles.css` | Dark/terminal theme |
| `app/renderer.ts` | All UI logic: top bar, frame table, dedup, filter, modal, recording, toasts |
| `app/package.json` | Dependencies + build scripts |
| `app/tsconfig.json` | TypeScript config |
| `app/tests/protocol.test.ts` | Unit tests for COBS decode + frame unpack |
| `app/tests/logger.test.ts` | Unit tests for CSV logger |
| `app/tests/serial.test.ts` | Unit tests for buffer parsing logic |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `app/package.json`
- Create: `app/tsconfig.json`
- Create: `app/.gitignore`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "cando",
  "version": "1.0.0",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "start": "npm run build && electron .",
    "test": "jest",
    "postinstall": "electron-rebuild"
  },
  "dependencies": {
    "serialport": "^12.0.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.12.12",
    "@types/serialport": "^8.0.5",
    "electron": "^28.3.3",
    "electron-rebuild": "^3.2.9",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.4",
    "typescript": "^5.4.5"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "roots": ["<rootDir>/tests"]
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020", "DOM"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Write .gitignore**

```
node_modules/
dist/
*.csv
```

- [ ] **Step 4: Install dependencies**

```bash
cd app
npm install
```

Expected: packages install, electron-rebuild runs for serialport. No errors.

- [ ] **Step 5: Verify TypeScript is available**

```bash
cd app
npx tsc --version
```

Expected: `Version 5.x.x`

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/tsconfig.json app/.gitignore app/package-lock.json
git commit -m "feat: scaffold electron app project"
```

---

### Task 2: Shared Types + COBS Decode + Frame Unpack (`src/protocol.ts`)

**Files:**
- Create: `app/src/protocol.ts`
- Create: `app/tests/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/tests/protocol.test.ts`:

```typescript
import { cobsDecode, unpackFrame, parseBuffer } from '../src/protocol';

describe('cobsDecode', () => {
  it('decodes a simple COBS frame (no zeros in payload)', () => {
    // payload: [0x11, 0x22, 0x33]
    // COBS encoded (no zeros): [0x04, 0x11, 0x22, 0x33]
    const encoded = Buffer.from([0x04, 0x11, 0x22, 0x33]);
    expect(cobsDecode(encoded)).toEqual(Buffer.from([0x11, 0x22, 0x33]));
  });

  it('decodes a frame containing a zero byte', () => {
    // payload: [0x11, 0x00, 0x22]
    // COBS: [0x02, 0x11, 0x02, 0x22]
    const encoded = Buffer.from([0x02, 0x11, 0x02, 0x22]);
    expect(cobsDecode(encoded)).toEqual(Buffer.from([0x11, 0x00, 0x22]));
  });

  it('returns null for empty input', () => {
    expect(cobsDecode(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for single-byte input (no payload)', () => {
    // [0x01] = overhead byte pointing to itself = valid COBS for empty payload
    expect(cobsDecode(Buffer.from([0x01]))).toEqual(Buffer.alloc(0));
  });
});

describe('unpackFrame', () => {
  it('unpacks a standard 8-byte data frame', () => {
    // Wire format: [4B id LE][1B flags][1B dlc][8B data]
    // id=0x02FF, flags=0x00 (standard, no RTR), dlc=8
    const buf = Buffer.alloc(14);
    buf.writeUInt32LE(0x02FF, 0);
    buf[4] = 0x00; // flags
    buf[5] = 8;    // dlc
    buf.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88], 6);

    const frame = unpackFrame(buf, 0, 0);
    expect(frame).not.toBeNull();
    expect(frame!.id).toBe(0x02FF);
    expect(frame!.ext).toBe(false);
    expect(frame!.rtr).toBe(false);
    expect(frame!.dlc).toBe(8);
    expect(Array.from(frame!.data)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  });

  it('unpacks an extended frame (EXT flag bit 0)', () => {
    const buf = Buffer.alloc(14);
    buf.writeUInt32LE(0x1FFFFFFF, 0);
    buf[4] = 0x01; // ext flag
    buf[5] = 3;
    buf.set([0xAA, 0xBB, 0xCC], 6);

    const frame = unpackFrame(buf, 0, 0);
    expect(frame!.ext).toBe(true);
    expect(frame!.rtr).toBe(false);
    expect(frame!.id).toBe(0x1FFFFFFF);
  });

  it('unpacks an RTR frame (RTR flag bit 1)', () => {
    const buf = Buffer.alloc(14);
    buf.writeUInt32LE(0x02FF, 0);
    buf[4] = 0x02; // rtr flag
    buf[5] = 0;

    const frame = unpackFrame(buf, 0, 0);
    expect(frame!.rtr).toBe(true);
    expect(frame!.dlc).toBe(0);
  });

  it('returns null for a buffer shorter than 14 bytes', () => {
    expect(unpackFrame(Buffer.alloc(13), 0, 0)).toBeNull();
  });
});

describe('parseBuffer', () => {
  it('extracts a complete COBS frame from the accumulation buffer', () => {
    // Build a valid wire frame (14 bytes) and COBS-encode it
    const wire = Buffer.alloc(14);
    wire.writeUInt32LE(0x100, 0);
    wire[4] = 0x00;
    wire[5] = 2;
    wire.set([0xAA, 0xBB], 6);

    // Manually COBS encode: find zeros and build encoded form
    // Since wire has no zeros (unless data has zeros), simplest: use actual encoder logic
    // For test purposes, place a known encoded block + 0x00 delimiter
    const frames: ReturnType<typeof unpackFrame>[] = [];
    const responses: string[] = [];

    // Encode wire frame using our COBS logic
    const encoded = cobsEncodeForTest(wire);
    const buf = Buffer.concat([encoded, Buffer.from([0x00])]);

    parseBuffer(buf, 0, 0, (f) => frames.push(f), (_r) => responses.push(_r));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(0x100);
  });

  it('extracts a command response line ending with 0x0A', () => {
    const frames: ReturnType<typeof unpackFrame>[] = [];
    const responses: string[] = [];
    const buf = Buffer.from('OK\n');
    parseBuffer(buf, 0, 0, (f) => frames.push(f), (r) => responses.push(r));
    expect(responses).toEqual(['OK']);
    expect(frames).toHaveLength(0);
  });

  it('handles partial frames without emitting', () => {
    const frames: ReturnType<typeof unpackFrame>[] = [];
    const responses: string[] = [];
    const buf = Buffer.from([0x04, 0x11, 0x22]); // no 0x00 terminator yet
    parseBuffer(buf, 0, 0, (f) => frames.push(f), (_r) => {});
    expect(frames).toHaveLength(0);
  });
});

// Helper: basic COBS encoder for test data (no external deps)
function cobsEncodeForTest(src: Buffer): Buffer {
  const dst = Buffer.alloc(src.length + 2);
  let out = 0;
  let codeIdx = out++;
  let run = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x00) {
      dst[codeIdx] = run; codeIdx = out++; run = 1;
    } else {
      dst[out++] = src[i]; run++;
      if (run === 0xFF) { dst[codeIdx] = run; codeIdx = out++; run = 1; }
    }
  }
  dst[codeIdx] = run;
  return dst.slice(0, out);
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app
npx jest tests/protocol.test.ts
```

Expected: FAIL — `Cannot find module '../src/protocol'`

- [ ] **Step 3: Write `src/protocol.ts`**

```typescript
export interface CanFrame {
  seq:  number;
  ts:   number;
  id:   number;
  ext:  boolean;
  rtr:  boolean;
  dlc:  number;
  data: Uint8Array;
}

export interface PortInfo {
  path:         string;
  manufacturer: string | undefined;
}

export type SpeedIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface AppStatus {
  connected:   boolean;
  channelOpen: boolean;
  recording:   boolean;
  recordPath:  string | null;
  errorCount:  number;
}

export interface CanDoAPI {
  listPorts():                                      Promise<PortInfo[]>;
  connect(path: string):                            Promise<void>;
  disconnect():                                     Promise<void>;
  setSpeed(index: SpeedIndex):                      Promise<'OK' | 'KO'>;
  openChannel():                                    Promise<'OK' | 'KO'>;
  closeChannel():                                   Promise<'OK' | 'KO'>;
  startLogging():                                   Promise<string>;
  stopLogging():                                    Promise<void>;
  onFrame(cb: (frame: CanFrame) => void):           void;
  onStatus(cb: (status: AppStatus) => void):        void;
}

// Decodes a COBS-encoded buffer (NOT including the 0x00 delimiter).
// Returns decoded bytes, or null if input is empty.
export function cobsDecode(encoded: Buffer): Buffer | null {
  if (encoded.length === 0) return null;
  const dst: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    const code = encoded[i++];
    for (let j = 1; j < code; j++) {
      if (i >= encoded.length) break;
      dst.push(encoded[i++]);
    }
    if (code < 0xFF && i < encoded.length) {
      dst.push(0x00);
    }
  }
  // Remove trailing zero added by the overhead byte at end
  if (dst.length > 0 && dst[dst.length - 1] === 0x00) dst.pop();
  return Buffer.from(dst);
}

// Wire format: [4B id LE][1B flags (bit0=EXT, bit1=RTR)][1B dlc][8B data]
// seq and ts are assigned by the caller.
export function unpackFrame(buf: Buffer, seq: number, ts: number): CanFrame | null {
  if (buf.length < 14) return null;
  const id   = buf.readUInt32LE(0);
  const flags = buf[4];
  const dlc  = buf[5];
  const data = new Uint8Array(buf.buffer, buf.byteOffset + 6, 8);
  return {
    seq,
    ts,
    id,
    ext:  (flags & 0x01) !== 0,
    rtr:  (flags & 0x02) !== 0,
    dlc,
    data,
  };
}

// Scans a buffer for complete COBS frames (0x00-delimited) and command
// response lines (0x0A-terminated). Calls onFrame or onResponse for each.
// Returns the remaining unconsumed bytes.
export function parseBuffer(
  buf: Buffer,
  seq: number,
  ts: number,
  onFrame: (f: CanFrame) => void,
  onResponse: (r: string) => void,
): Buffer {
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) {
      const chunk = buf.slice(start, i);
      start = i + 1;
      if (chunk.length === 0) continue;
      const decoded = cobsDecode(chunk);
      if (decoded === null) continue;
      const frame = unpackFrame(decoded, seq, ts);
      if (frame) onFrame(frame);
    } else if (buf[i] === 0x0A) {
      const line = buf.slice(start, i).toString('ascii').replace(/\r/g, '').trim();
      start = i + 1;
      if (line.length > 0) onResponse(line);
    }
  }
  return buf.slice(start);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app
npx jest tests/protocol.test.ts
```

Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add app/src/protocol.ts app/tests/protocol.test.ts
git commit -m "feat: add protocol types, COBS decode, frame unpack"
```

---

### Task 3: CSV Logger (`src/logger.ts`)

**Files:**
- Create: `app/src/logger.ts`
- Create: `app/tests/logger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/tests/logger.test.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../src/logger';
import type { CanFrame } from '../src/protocol';

function makeFrame(overrides: Partial<CanFrame> = {}): CanFrame {
  return {
    seq: 0, ts: 0, id: 0x100, ext: false, rtr: false, dlc: 2,
    data: new Uint8Array([0xAA, 0xBB, 0, 0, 0, 0, 0, 0]),
    ...overrides,
  };
}

describe('Logger', () => {
  let tmpFile: string;
  let logger: Logger;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cando-test-${Date.now()}.csv`);
    logger = new Logger();
  });

  afterEach(() => {
    logger.stopLogging();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('writes header row on start', (done) => {
    logger.startLogging(tmpFile);
    setTimeout(() => {
      const content = fs.readFileSync(tmpFile, 'utf8');
      expect(content.startsWith('seq,ts_ms,id_hex,ext,rtr,dlc,data_hex\n')).toBe(true);
      done();
    }, 100);
  });

  it('appends a frame row with correct CSV fields', (done) => {
    logger.startLogging(tmpFile);
    logger.appendFrame(makeFrame({ seq: 5, ts: 1234, id: 0x2FF, ext: false, rtr: false, dlc: 2 }));
    logger.stopLogging();
    setTimeout(() => {
      const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const [seq, ts, id, ext, rtr, dlc, data] = lines[1].split(',');
      expect(seq).toBe('5');
      expect(ts).toBe('1234');
      expect(id).toBe('000002FF');
      expect(ext).toBe('0');
      expect(rtr).toBe('0');
      expect(dlc).toBe('2');
      expect(data).toBe('AA BB');
      done();
    }, 150);
  });

  it('formats EXT and RTR flags as 1', (done) => {
    logger.startLogging(tmpFile);
    logger.appendFrame(makeFrame({ ext: true, rtr: true, dlc: 0 }));
    logger.stopLogging();
    setTimeout(() => {
      const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
      const [, , , ext, rtr] = lines[1].split(',');
      expect(ext).toBe('1');
      expect(rtr).toBe('1');
      done();
    }, 150);
  });

  it('only logs dlc bytes of data', (done) => {
    logger.startLogging(tmpFile);
    logger.appendFrame(makeFrame({
      dlc: 3,
      data: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0, 0, 0, 0])
    }));
    logger.stopLogging();
    setTimeout(() => {
      const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
      const data = lines[1].split(',')[6];
      expect(data).toBe('11 22 33');
      done();
    }, 150);
  });

  it('does nothing on appendFrame when not logging', () => {
    expect(() => logger.appendFrame(makeFrame())).not.toThrow();
  });

  it('emits error event on write failure', (done) => {
    logger.startLogging('/no/such/dir/test.csv');
    logger.on('error', (err: Error) => {
      expect(err.message).toBeTruthy();
      done();
    });
    logger.appendFrame(makeFrame());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app
npx jest tests/logger.test.ts
```

Expected: FAIL — `Cannot find module '../src/logger'`

- [ ] **Step 3: Write `src/logger.ts`**

```typescript
import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { CanFrame } from './protocol';

export class Logger extends EventEmitter {
  private stream: fs.WriteStream | null = null;

  startLogging(filePath: string): void {
    this.stream = fs.createWriteStream(filePath, { flags: 'w' });
    this.stream.on('error', (err) => {
      this.stream = null;
      this.emit('error', err);
    });
    this.stream.write('seq,ts_ms,id_hex,ext,rtr,dlc,data_hex\n');
  }

  appendFrame(frame: CanFrame): void {
    if (!this.stream) return;
    const idHex  = frame.id.toString(16).toUpperCase().padStart(8, '0');
    const dataHex = Array.from(frame.data.slice(0, frame.dlc))
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
    const row = [
      frame.seq,
      frame.ts,
      idHex,
      frame.ext ? 1 : 0,
      frame.rtr ? 1 : 0,
      frame.dlc,
      dataHex,
    ].join(',') + '\n';
    this.stream.write(row);
  }

  stopLogging(): void {
    if (!this.stream) return;
    this.stream.end();
    this.stream = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app
npx jest tests/logger.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/logger.ts app/tests/logger.test.ts
git commit -m "feat: add CSV logger"
```

---

### Task 4: Serial Manager (`src/serial.ts`)

**Files:**
- Create: `app/src/serial.ts`
- Create: `app/tests/serial.test.ts`

The `SerialManager` wraps `SerialPort`, accumulates bytes, routes COBS frames and command responses using `parseBuffer`, and maintains a command queue where each entry holds a resolve/reject + timeout handle.

- [ ] **Step 1: Write the failing tests**

Create `app/tests/serial.test.ts`:

```typescript
// These tests exercise parseBuffer integration through SerialManager._handleData.
// SerialPort itself is not mocked — we call the internal handler directly.
import { SerialManager } from '../src/serial';

describe('SerialManager._handleData', () => {
  let mgr: SerialManager;

  beforeEach(() => {
    mgr = new SerialManager();
  });

  afterEach(() => {
    mgr.removeAllListeners();
  });

  it('emits frame event when a complete COBS frame arrives', (done) => {
    mgr.on('frame', (frame) => {
      expect(frame.id).toBe(0x100);
      done();
    });

    // Build a wire frame for id=0x100, flags=0, dlc=2, data=[0xAA,0xBB,...]
    const wire = Buffer.alloc(14);
    wire.writeUInt32LE(0x100, 0);
    wire[4] = 0x00;
    wire[5] = 2;
    wire.set([0xAA, 0xBB], 6);
    const encoded = cobsEncode(wire);
    const packet = Buffer.concat([encoded, Buffer.from([0x00])]);

    (mgr as any)._handleData(packet);
  });

  it('resolves pending command on OK response', (done) => {
    const p = (mgr as any)._enqueueCommand('S1');
    p.then((result: string) => {
      expect(result).toBe('OK');
      done();
    });
    (mgr as any)._handleData(Buffer.from('OK\n'));
  });

  it('rejects pending command on KO response', (done) => {
    const p = (mgr as any)._enqueueCommand('S1');
    p.catch((err: Error) => {
      expect(err.message).toBe('KO');
      done();
    });
    (mgr as any)._handleData(Buffer.from('KO\n'));
  });

  it('accumulates partial data across multiple calls', (done) => {
    mgr.on('frame', (frame) => {
      expect(frame.id).toBe(0x200);
      done();
    });

    const wire = Buffer.alloc(14);
    wire.writeUInt32LE(0x200, 0);
    wire[4] = 0x00;
    wire[5] = 1;
    wire[6] = 0xFF;
    const encoded = cobsEncode(wire);
    const packet = Buffer.concat([encoded, Buffer.from([0x00])]);

    // Split the packet in two and deliver separately
    (mgr as any)._handleData(packet.slice(0, 5));
    (mgr as any)._handleData(packet.slice(5));
  });
});

// Minimal COBS encoder for test data
function cobsEncode(src: Buffer): Buffer {
  const dst = Buffer.alloc(src.length + 2);
  let out = 0;
  let codeIdx = out++;
  let run = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x00) {
      dst[codeIdx] = run; codeIdx = out++; run = 1;
    } else {
      dst[out++] = src[i]; run++;
      if (run === 0xFF) { dst[codeIdx] = run; codeIdx = out++; run = 1; }
    }
  }
  dst[codeIdx] = run;
  return dst.slice(0, out);
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app
npx jest tests/serial.test.ts
```

Expected: FAIL — `Cannot find module '../src/serial'`

- [ ] **Step 3: Write `src/serial.ts`**

```typescript
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import { parseBuffer, CanFrame } from './protocol';

const COMMAND_TIMEOUT_MS = 2000;

interface PendingCommand {
  resolve: (value: string) => void;
  reject:  (err: Error)   => void;
  timer:   ReturnType<typeof setTimeout>;
}

export class SerialManager extends EventEmitter {
  private port:    SerialPort | null = null;
  private buf:     Buffer = Buffer.alloc(0);
  private queue:   PendingCommand[] = [];
  private seq:     number = 0;
  private openTs:  number = 0;

  async open(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = new SerialPort({ path, baudRate: 115200, autoOpen: false });
      p.open((err) => {
        if (err) return reject(err);
        this.port   = p;
        this.buf    = Buffer.alloc(0);
        this.seq    = 0;
        this.openTs = 0;
        p.on('data', (chunk: Buffer) => this._handleData(chunk));
        p.on('close', () => {
          this._flushQueue(new Error('Port closed'));
          this.port = null;
          this.emit('close');
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.port) return resolve();
      this.port.close(() => resolve());
    });
  }

  sendCommand(cmd: string): Promise<string> {
    return this._enqueueCommand(cmd);
  }

  markChannelOpen(): void {
    this.openTs = Date.now();
  }

  markChannelClosed(): void {
    this.openTs = 0;
  }

  // Internal — exposed for testing
  _handleData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const now = Date.now();
    const ts  = this.openTs ? now - this.openTs : 0;

    this.buf = parseBuffer(
      this.buf,
      this.seq,
      ts,
      (frame: CanFrame) => {
        this.seq++;
        this.emit('frame', frame);
      },
      (response: string) => {
        const pending = this.queue.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        if (response === 'OK') pending.resolve(response);
        else pending.reject(new Error(response));
      },
    );
  }

  _enqueueCommand(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((p) => p.timer === timer);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error('Command timeout'));
      }, COMMAND_TIMEOUT_MS);

      this.queue.push({ resolve, reject, timer });

      if (this.port) {
        this.port.write(`${cmd}\n`);
      }
    });
  }

  private _flushQueue(err: Error): void {
    for (const p of this.queue) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.queue = [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app
npx jest tests/serial.test.ts
```

Expected: PASS

- [ ] **Step 5: Run all tests**

```bash
cd app
npx jest
```

Expected: All tests in all three test files PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/serial.ts app/tests/serial.test.ts
git commit -m "feat: add serial manager with command queue"
```

---

### Task 5: Main Process (`main.ts`)

**Files:**
- Create: `app/main.ts`

- [ ] **Step 1: Write `main.ts`**

```typescript
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { SerialPort } from 'serialport';
import { SerialManager } from './src/serial';
import { Logger } from './src/logger';
import type { AppStatus, SpeedIndex } from './src/protocol';

const SPEEDS: Record<SpeedIndex, string> = {
  1: 'S1', 2: 'S2', 3: 'S3', 4: 'S4',
  5: 'S5', 6: 'S6', 7: 'S7', 8: 'S8',
};

let win:    BrowserWindow | null = null;
let serial: SerialManager        = new SerialManager();
let logger: Logger               = new Logger();

let status: AppStatus = {
  connected:   false,
  channelOpen: false,
  recording:   false,
  recordPath:  null,
  errorCount:  0,
};

function pushStatus(): void {
  win?.webContents.send('status', { ...status });
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  serial.on('frame', (frame) => {
    logger.appendFrame(frame);
    win?.webContents.send('frame', frame);
  });

  serial.on('close', () => {
    status.connected   = false;
    status.channelOpen = false;
    if (status.recording) {
      logger.stopLogging();
      status.recording  = false;
      status.recordPath = null;
    }
    pushStatus();
  });

  logger.on('error', (err: Error) => {
    logger.stopLogging();
    status.recording  = false;
    status.recordPath = null;
    pushStatus();
    win?.webContents.send('toast', `Recording error: ${err.message}`);
  });
});

app.on('window-all-closed', () => app.quit());

// IPC handlers

ipcMain.handle('listPorts', async () => {
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer }));
});

ipcMain.handle('connect', async (_e, portPath: string) => {
  await serial.open(portPath);
  status.connected = true;
  pushStatus();
});

ipcMain.handle('disconnect', async () => {
  if (status.channelOpen) {
    try { await serial.sendCommand('C'); } catch (_) {}
    serial.markChannelClosed();
    status.channelOpen = false;
  }
  if (status.recording) {
    logger.stopLogging();
    status.recording  = false;
    status.recordPath = null;
  }
  await serial.close();
  status.connected = false;
  pushStatus();
});

ipcMain.handle('setSpeed', async (_e, index: SpeedIndex) => {
  const cmd = SPEEDS[index];
  const result = await serial.sendCommand(cmd);
  return result;
});

ipcMain.handle('openChannel', async () => {
  const result = await serial.sendCommand('O');
  if (result === 'OK') {
    serial.markChannelOpen();
    status.channelOpen = true;
    pushStatus();
  }
  return result;
});

ipcMain.handle('closeChannel', async () => {
  const result = await serial.sendCommand('C');
  if (result === 'OK') {
    serial.markChannelClosed();
    status.channelOpen = false;
    pushStatus();
  }
  return result;
});

ipcMain.handle('startLogging', async () => {
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: `session-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) throw new Error('Cancelled');
  logger.startLogging(result.filePath);
  status.recording  = true;
  status.recordPath = result.filePath;
  pushStatus();
  return result.filePath;
});

ipcMain.handle('stopLogging', async () => {
  logger.stopLogging();
  status.recording  = false;
  status.recordPath = null;
  pushStatus();
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd app
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add app/main.ts
git commit -m "feat: add main process with IPC handlers"
```

---

### Task 6: Preload (`preload.ts`)

**Files:**
- Create: `app/preload.ts`

- [ ] **Step 1: Write `preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import type { CanFrame, PortInfo, SpeedIndex, AppStatus, CanDoAPI } from './src/protocol';

const api: CanDoAPI = {
  listPorts:    ()        => ipcRenderer.invoke('listPorts'),
  connect:      (path)    => ipcRenderer.invoke('connect', path),
  disconnect:   ()        => ipcRenderer.invoke('disconnect'),
  setSpeed:     (index)   => ipcRenderer.invoke('setSpeed', index),
  openChannel:  ()        => ipcRenderer.invoke('openChannel'),
  closeChannel: ()        => ipcRenderer.invoke('closeChannel'),
  startLogging: ()        => ipcRenderer.invoke('startLogging'),
  stopLogging:  ()        => ipcRenderer.invoke('stopLogging'),
  onFrame:      (cb)      => ipcRenderer.on('frame',  (_e, f: CanFrame)    => cb(f)),
  onStatus:     (cb)      => ipcRenderer.on('status', (_e, s: AppStatus)   => cb(s)),
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd app
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add app/preload.ts
git commit -m "feat: add preload contextBridge"
```

---

### Task 7: HTML Shell + Styles

**Files:**
- Create: `app/index.html`
- Create: `app/styles.css`

- [ ] **Step 1: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
  <title>CANdo</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>

  <!-- Top bar -->
  <div id="top-bar">
    <span class="label">PORT</span>
    <select id="port-select"></select>
    <button id="refresh-btn" title="Refresh ports">⟳</button>
    <span class="divider">│</span>
    <span class="label">SPEED</span>
    <select id="speed-select">
      <option value="1">1.000 Mbps</option>
      <option value="2">2.000 Mbps</option>
      <option value="3">~3.0 Mbps</option>
      <option value="4">4.000 Mbps</option>
      <option value="5">~4.9 Mbps</option>
      <option value="6">~5.8 Mbps</option>
      <option value="7">~7.1 Mbps</option>
      <option value="8">8.000 Mbps</option>
    </select>
    <span class="divider">│</span>
    <button id="connect-btn" class="btn-connect">Connect</button>
    <button id="channel-btn" class="btn-channel" disabled>Open</button>
    <span class="divider">│</span>
    <button id="record-btn" disabled>⏺ Record</button>
    <span style="flex:1"></span>
    <span class="label">Frames: <span id="frame-count">0</span></span>
    <button id="clear-btn">Clear</button>
  </div>

  <!-- Filter bar -->
  <div id="filter-bar">
    <span class="label">FILTER</span>
    <input id="filter-input" type="text" placeholder="ID or data…" />
    <button id="idlist-btn">ID List…</button>
    <span id="filter-count" class="label"></span>
  </div>

  <!-- Table header -->
  <div id="table-header" class="table-row header-row">
    <span>#</span>
    <span>LAST SEEN</span>
    <span>ID</span>
    <span>FLAGS</span>
    <span>DLC</span>
    <span>COUNT</span>
    <span>DATA</span>
  </div>

  <!-- Frame log -->
  <div id="frame-log"></div>

  <!-- Status bar -->
  <div id="status-bar">
    <span id="status-conn">⬤ <span>Disconnected</span></span>
    <span id="status-channel">Channel: <span>Closed</span></span>
    <span id="status-speed">Speed: <span>—</span></span>
    <span style="flex:1"></span>
    <span id="status-record"></span>
  </div>

  <!-- ID List modal -->
  <div id="modal-overlay" class="hidden">
    <div id="modal">
      <div id="modal-header">
        <span>CAN ID Filter</span>
        <button id="modal-close">✕</button>
      </div>
      <div id="modal-mode">
        <button id="mode-allow" class="active">Allowlist</button>
        <button id="mode-block">Blocklist</button>
      </div>
      <textarea id="modal-ids" placeholder="One hex ID per line, e.g.&#10;02FF&#10;1FFFFFFF"></textarea>
      <div id="modal-footer">
        <button id="modal-apply">Apply</button>
        <button id="modal-cancel">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Toast container -->
  <div id="toast-container"></div>

  <script src="dist/renderer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `styles.css`**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0d1117;
  color: #c9d1d9;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

button {
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  border-radius: 4px;
  padding: 3px 10px;
}

select, input {
  font-family: inherit;
  font-size: 11px;
  background: #21262d;
  border: 1px solid #30363d;
  color: #c9d1d9;
  border-radius: 4px;
  padding: 3px 6px;
}

.label { color: #8b949e; font-size: 10px; }
.divider { color: #30363d; }

/* Top bar */
#top-bar {
  background: #161b22;
  border-bottom: 1px solid #30363d;
  padding: 8px 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.btn-connect {
  background: #238636;
  border: 1px solid #2ea043;
  color: #fff;
  padding: 3px 12px;
}
.btn-connect.disconnecting {
  background: #b91c1c;
  border-color: #f85149;
}

.btn-channel {
  background: #1f6feb;
  border: 1px solid #388bfd;
  color: #fff;
  padding: 3px 12px;
}
.btn-channel.open {
  background: #21262d;
  border-color: #30363d;
  color: #c9d1d9;
}

#record-btn {
  background: #21262d;
  border: 1px solid #30363d;
  color: #c9d1d9;
}
#record-btn.recording {
  background: #7f1d1d;
  border-color: #f85149;
  color: #f85149;
}

#clear-btn, #refresh-btn {
  background: #21262d;
  border: 1px solid #30363d;
  color: #8b949e;
}

button:disabled { opacity: 0.4; cursor: default; }

/* Filter bar */
#filter-bar {
  background: #0d1117;
  border-bottom: 1px solid #21262d;
  padding: 5px 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}

#filter-input { width: 180px; }

#idlist-btn {
  background: #21262d;
  border: 1px solid #30363d;
  color: #8b949e;
  padding: 2px 8px;
  font-size: 10px;
}

/* Table header */
.table-row {
  display: grid;
  grid-template-columns: 50px 72px 110px 56px 42px 58px 1fr;
  gap: 8px;
  padding: 4px 12px;
}

#table-header {
  background: #161b22;
  border-bottom: 1px solid #30363d;
  color: #8b949e;
  font-size: 10px;
  flex-shrink: 0;
}

/* Frame log */
#frame-log {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
}

.frame-row {
  display: grid;
  grid-template-columns: 50px 72px 110px 56px 42px 58px 1fr;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px solid #161b22;
  color: #39d353;
}
.frame-row:nth-child(even) { background: rgba(255,255,255,0.02); }
.frame-row.ext { color: #58a6ff; }
.frame-row.rtr { color: #f85149; }

.frame-row .col-seq,
.frame-row .col-ts  { color: #8b949e; }

.count-badge {
  background: #1f3a1f;
  color: #39d353;
  border-radius: 3px;
  padding: 0 5px;
  text-align: center;
  display: inline-block;
  min-width: 28px;
}

.count-muted { color: #8b949e; text-align: center; }

.col-flags-ext { color: #e3b341; }
.col-flags-rtr { color: #f85149; }

/* Status bar */
#status-bar {
  background: #161b22;
  border-top: 1px solid #30363d;
  padding: 4px 12px;
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 10px;
  color: #8b949e;
  flex-shrink: 0;
}

#status-conn.connected span  { color: #39d353; }
#status-conn.disconnected span { color: #8b949e; }
#status-channel.open span    { color: #58a6ff; }
#status-record               { color: #f85149; }

/* Modal */
#modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
#modal-overlay.hidden { display: none; }

#modal {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  width: 320px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

#modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: #c9d1d9;
}

#modal-close {
  background: none; border: none;
  color: #8b949e; font-size: 14px; padding: 0;
}

#modal-mode { display: flex; gap: 6px; }
#modal-mode button {
  flex: 1;
  background: #21262d;
  border: 1px solid #30363d;
  color: #8b949e;
}
#modal-mode button.active {
  background: #1f6feb;
  border-color: #388bfd;
  color: #fff;
}

#modal-ids {
  width: 100%;
  height: 140px;
  resize: vertical;
  background: #0d1117;
  border: 1px solid #30363d;
  color: #c9d1d9;
  border-radius: 4px;
  padding: 6px;
  font-family: inherit;
  font-size: 11px;
}

#modal-footer { display: flex; gap: 8px; justify-content: flex-end; }
#modal-apply { background: #238636; border: 1px solid #2ea043; color: #fff; }
#modal-cancel { background: #21262d; border: 1px solid #30363d; color: #8b949e; }

/* Toasts */
#toast-container {
  position: fixed; bottom: 32px; right: 16px;
  display: flex; flex-direction: column; gap: 6px;
  z-index: 200;
}

.toast {
  background: #7f1d1d;
  border: 1px solid #f85149;
  color: #fca5a5;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 11px;
  animation: fadein 0.2s ease;
}

@keyframes fadein {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Verify HTML is well-formed**

Open `app/index.html` in any browser (drag to browser). Check: layout structure renders, no console errors.

- [ ] **Step 4: Commit**

```bash
git add app/index.html app/styles.css
git commit -m "feat: add HTML shell and dark terminal styles"
```

---

### Task 8: Renderer — Init + Top Bar + Status Bar

**Files:**
- Create: `app/renderer.ts`

This file uses `import type` only for types from `src/protocol.ts` (erased at compile time — no `require` generated, which matters because this file runs in the browser renderer context, not Node.js).

- [ ] **Step 1: Write `renderer.ts` (initial: top bar + status bar)**

```typescript
import type { CanFrame, AppStatus, SpeedIndex } from './src/protocol';

declare global {
  interface Window {
    api: {
      listPorts():                                    Promise<{ path: string; manufacturer?: string }[]>;
      connect(path: string):                          Promise<void>;
      disconnect():                                   Promise<void>;
      setSpeed(index: number):                        Promise<'OK' | 'KO'>;
      openChannel():                                  Promise<'OK' | 'KO'>;
      closeChannel():                                 Promise<'OK' | 'KO'>;
      startLogging():                                 Promise<string>;
      stopLogging():                                  Promise<void>;
      onFrame(cb: (frame: CanFrame) => void):         void;
      onStatus(cb: (status: AppStatus) => void):      void;
    };
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let appStatus: AppStatus = {
  connected: false, channelOpen: false,
  recording: false, recordPath: null, errorCount: 0,
};
let totalFrames = 0;

// ── Elements ─────────────────────────────────────────────────────────────────

const portSelect   = document.getElementById('port-select')!   as HTMLSelectElement;
const speedSelect  = document.getElementById('speed-select')!  as HTMLSelectElement;
const connectBtn   = document.getElementById('connect-btn')!   as HTMLButtonElement;
const channelBtn   = document.getElementById('channel-btn')!   as HTMLButtonElement;
const recordBtn    = document.getElementById('record-btn')!    as HTMLButtonElement;
const refreshBtn   = document.getElementById('refresh-btn')!   as HTMLButtonElement;
const clearBtn     = document.getElementById('clear-btn')!     as HTMLButtonElement;
const frameCount   = document.getElementById('frame-count')!;
const filterInput  = document.getElementById('filter-input')!  as HTMLInputElement;
const filterCount  = document.getElementById('filter-count')!;
const idlistBtn    = document.getElementById('idlist-btn')!    as HTMLButtonElement;
const frameLog     = document.getElementById('frame-log')!;
const statusConn   = document.getElementById('status-conn')!;
const statusChan   = document.getElementById('status-channel')!;
const statusSpeed  = document.getElementById('status-speed')!;
const statusRec    = document.getElementById('status-record')!;
const modalOverlay = document.getElementById('modal-overlay')!;
const modalClose   = document.getElementById('modal-close')!   as HTMLButtonElement;
const modeAllow    = document.getElementById('mode-allow')!    as HTMLButtonElement;
const modeBlock    = document.getElementById('mode-block')!    as HTMLButtonElement;
const modalIds     = document.getElementById('modal-ids')!     as HTMLTextAreaElement;
const modalApply   = document.getElementById('modal-apply')!   as HTMLButtonElement;
const modalCancel  = document.getElementById('modal-cancel')!  as HTMLButtonElement;
const toastCont    = document.getElementById('toast-container')!;

// ── Port list ─────────────────────────────────────────────────────────────────

async function refreshPorts(): Promise<void> {
  const ports = await window.api.listPorts();
  portSelect.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.path + (p.manufacturer ? ` (${p.manufacturer})` : '');
    portSelect.appendChild(opt);
  }
}

// ── Connect / Disconnect ──────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  try {
    if (!appStatus.connected) {
      await window.api.connect(portSelect.value);
    } else {
      await window.api.disconnect();
    }
  } catch (err: any) {
    showToast(err.message ?? String(err));
    connectBtn.disabled = false;
  }
});

// ── Open / Close Channel ──────────────────────────────────────────────────────

channelBtn.addEventListener('click', async () => {
  channelBtn.disabled = true;
  try {
    if (!appStatus.channelOpen) {
      const speedIdx = parseInt(speedSelect.value, 10) as SpeedIndex;
      const sr = await window.api.setSpeed(speedIdx);
      if (sr !== 'OK') throw new Error(`setSpeed returned ${sr}`);
      const or = await window.api.openChannel();
      if (or !== 'OK') throw new Error(`openChannel returned ${or}`);
    } else {
      const cr = await window.api.closeChannel();
      if (cr !== 'OK') throw new Error(`closeChannel returned ${cr}`);
    }
  } catch (err: any) {
    showToast(err.message ?? String(err));
  }
  channelBtn.disabled = false;
});

// ── Record ────────────────────────────────────────────────────────────────────

recordBtn.addEventListener('click', async () => {
  recordBtn.disabled = true;
  try {
    if (!appStatus.recording) {
      await window.api.startLogging();
    } else {
      await window.api.stopLogging();
    }
  } catch (err: any) {
    if ((err.message ?? '') !== 'Cancelled') {
      showToast(err.message ?? String(err));
    }
  }
  recordBtn.disabled = false;
});

// ── Refresh + Clear ───────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', refreshPorts);

clearBtn.addEventListener('click', () => {
  rowByKey.clear();
  rowByDisplayIdx.clear();
  frameLog.innerHTML = '';
  totalFrames = 0;
  frameCount.textContent = '0';
  updateFilterCount();
});

// ── Status updates ────────────────────────────────────────────────────────────

const SPEED_LABELS: Record<number, string> = {
  1: '1.000 Mbps', 2: '2.000 Mbps', 3: '~3.0 Mbps', 4: '4.000 Mbps',
  5: '~4.9 Mbps',  6: '~5.8 Mbps',  7: '~7.1 Mbps', 8: '8.000 Mbps',
};

window.api.onStatus((s) => {
  appStatus = s;

  // Connect button
  connectBtn.disabled = false;
  connectBtn.textContent = s.connected ? 'Disconnect' : 'Connect';
  connectBtn.classList.toggle('disconnecting', s.connected);

  // Channel button
  channelBtn.disabled = !s.connected;
  channelBtn.textContent = s.channelOpen ? 'Close' : 'Open';
  channelBtn.classList.toggle('open', s.channelOpen);

  // Record button
  recordBtn.disabled = !s.channelOpen;
  recordBtn.textContent = s.recording ? '⏹ Stop' : '⏺ Record';
  recordBtn.classList.toggle('recording', s.recording);

  // Status bar
  statusConn.className = s.connected ? 'connected' : 'disconnected';
  statusConn.querySelector('span')!.textContent = s.connected ? 'Connected' : 'Disconnected';

  statusChan.className = s.channelOpen ? 'open' : '';
  statusChan.querySelector('span')!.textContent = s.channelOpen ? 'Open' : 'Closed';

  const speedLabel = SPEED_LABELS[parseInt(speedSelect.value, 10)] ?? '—';
  statusSpeed.querySelector('span')!.textContent = s.channelOpen ? speedLabel : '—';

  if (s.recording && s.recordPath) {
    const fname = s.recordPath.split(/[/\\]/).pop()!;
    statusRec.textContent = `⏺ Recording → ${fname}`;
  } else {
    statusRec.textContent = '';
  }

  if (s.errorCount > 0) {
    statusRec.textContent += (statusRec.textContent ? '  ' : '') + `Errors: ${s.errorCount}`;
  }
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastCont.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Listen for toasts from main process (e.g. recording errors)
(window as any).api.onToast?.((msg: string) => showToast(msg));

// ── Placeholder stubs (filled in Tasks 9–11) ─────────────────────────────────

// These are defined in later tasks; declared here so the file compiles.
const rowByKey:         Map<string, HTMLElement> = new Map();
const rowByDisplayIdx:  Map<number, HTMLElement> = new Map();
function updateFilterCount(): void {}

// ── Boot ──────────────────────────────────────────────────────────────────────

refreshPorts();
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd app
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add app/renderer.ts
git commit -m "feat: renderer top bar, status bar, connect/channel/record wiring"
```

---

### Task 9: Renderer — Frame Table with Deduplication

**Files:**
- Modify: `app/renderer.ts`

Remove the placeholder stubs section from Task 8 and replace with the real frame table logic.

- [ ] **Step 1: Replace the placeholder stubs and add frame logic**

Find this block in `renderer.ts`:

```typescript
// ── Placeholder stubs (filled in Tasks 9–11) ─────────────────────────────────

// These are defined in later tasks; declared here so the file compiles.
const rowByKey:         Map<string, HTMLElement> = new Map();
const rowByDisplayIdx:  Map<number, HTMLElement> = new Map();
function updateFilterCount(): void {}
```

Replace it with:

```typescript
// ── Frame table ───────────────────────────────────────────────────────────────

const MAX_ROWS = 2000;

// Key: `${id.toString(16)}-${flags}-${dlc}-${dataHex}`
const rowByKey:        Map<string, HTMLElement> = new Map();
// Maps display index → DOM row (for overflow removal)
const rowByDisplayIdx: Map<number, HTMLElement> = new Map();
let   nextDisplayIdx = 0;

function frameKey(f: CanFrame): string {
  const dataHex = Array.from(f.data.slice(0, f.dlc))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${f.id.toString(16)}-${f.ext ? 1 : 0}${f.rtr ? 1 : 0}-${f.dlc}-${dataHex}`;
}

function formatDataHex(f: CanFrame): string {
  if (f.rtr) return '—';
  return Array.from(f.data.slice(0, f.dlc))
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ') || '—';
}

function formatTs(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function formatId(f: CanFrame): string {
  return f.ext
    ? f.id.toString(16).toUpperCase().padStart(8, '0')
    : f.id.toString(16).toUpperCase().padStart(4, '0');
}

window.api.onFrame((frame) => {
  totalFrames++;
  frameCount.textContent = String(totalFrames);

  const key = frameKey(frame);
  const existing = rowByKey.get(key);

  if (existing) {
    // Update in place
    const countEl = existing.querySelector('.count-val')!;
    const tsEl    = existing.querySelector('.col-ts')!;
    const prev    = parseInt(countEl.textContent ?? '1', 10);
    const next    = prev + 1;
    countEl.textContent = String(next);
    if (next > 1) {
      const wrapper = existing.querySelector('.count-cell')!;
      wrapper.innerHTML = `<span class="count-badge"><span class="count-val">${next}</span></span>`;
    }
    tsEl.textContent = formatTs(frame.ts);
  } else {
    // New row
    const row = document.createElement('div');
    row.className = 'frame-row' + (frame.ext ? ' ext' : '') + (frame.rtr ? ' rtr' : '');
    row.dataset['key'] = key;

    const flagsHtml = frame.ext
      ? `<span class="col-flags-ext">EXT</span>`
      : frame.rtr
        ? `<span class="col-flags-rtr">RTR</span>`
        : '';

    row.innerHTML = `
      <span class="col-seq">${String(nextDisplayIdx).padStart(3, '0')}</span>
      <span class="col-ts">${formatTs(frame.ts)}</span>
      <span class="col-id">${formatId(frame)}</span>
      <span class="col-flags">${flagsHtml}</span>
      <span class="col-dlc">${frame.dlc}</span>
      <span class="count-cell"><span class="count-muted"><span class="count-val">1</span></span></span>
      <span class="col-data">${formatDataHex(frame)}</span>
    `;

    rowByKey.set(key, row);
    rowByDisplayIdx.set(nextDisplayIdx, row);
    nextDisplayIdx++;

    frameLog.appendChild(row);
    applyFilterToRow(row);

    // Enforce 2000-row cap
    if (rowByKey.size > MAX_ROWS) {
      // Find the oldest display index still in the map
      const oldestIdx = nextDisplayIdx - rowByKey.size - 1;
      const oldRow = rowByDisplayIdx.get(oldestIdx);
      if (oldRow) {
        const oldKey = oldRow.dataset['key']!;
        rowByKey.delete(oldKey);
        rowByDisplayIdx.delete(oldestIdx);
        oldRow.remove();
      }
    }
  }

  maybeScrollToBottom();
  updateFilterCount();
});

// ── Auto-scroll ───────────────────────────────────────────────────────────────

let userScrolledUp = false;

frameLog.addEventListener('scroll', () => {
  const atBottom = frameLog.scrollHeight - frameLog.scrollTop - frameLog.clientHeight < 8;
  userScrolledUp = !atBottom;
});

function maybeScrollToBottom(): void {
  if (!userScrolledUp) {
    frameLog.scrollTop = frameLog.scrollHeight;
  }
}

// ── Filter ────────────────────────────────────────────────────────────────────

let filterText = '';
let idFilterMode: 'allow' | 'block' = 'allow';
let idFilterSet: Set<string> = new Set();

function rowMatchesFilter(row: HTMLElement): boolean {
  const idEl   = row.querySelector('.col-id');
  const dataEl = row.querySelector('.col-data');
  const idTxt  = (idEl?.textContent ?? '').toLowerCase();
  const dataTxt = (dataEl?.textContent ?? '').toLowerCase();

  if (filterText && !idTxt.includes(filterText) && !dataTxt.includes(filterText.replace(/ /g, ''))) {
    return false;
  }

  if (idFilterSet.size > 0) {
    const idHex = idTxt.toUpperCase();
    const inSet = idFilterSet.has(idHex);
    if (idFilterMode === 'allow' && !inSet) return false;
    if (idFilterMode === 'block' &&  inSet) return false;
  }

  return true;
}

function applyFilterToRow(row: HTMLElement): void {
  (row as HTMLElement).style.display = rowMatchesFilter(row) ? '' : 'none';
}

function applyAllFilters(): void {
  for (const row of Array.from(frameLog.children) as HTMLElement[]) {
    applyFilterToRow(row);
  }
  updateFilterCount();
}

function updateFilterCount(): void {
  const total   = frameLog.children.length;
  const visible = Array.from(frameLog.children).filter(
    (r) => (r as HTMLElement).style.display !== 'none'
  ).length;
  filterCount.textContent = total > 0 ? `showing ${visible} / ${total}` : '';
}

filterInput.addEventListener('input', () => {
  filterText = filterInput.value.toLowerCase().trim();
  applyAllFilters();
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd app
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add app/renderer.ts
git commit -m "feat: renderer frame table with deduplication and auto-scroll"
```

---

### Task 10: Renderer — ID Filter Modal

**Files:**
- Modify: `app/renderer.ts`

Add the ID List modal button handlers at the end of `renderer.ts`.

- [ ] **Step 1: Add modal logic to the end of `renderer.ts`**

Append to `renderer.ts`:

```typescript
// ── ID List modal ─────────────────────────────────────────────────────────────

let pendingFilterMode: 'allow' | 'block' = 'allow';

idlistBtn.addEventListener('click', () => {
  pendingFilterMode = idFilterMode;
  modalIds.value = Array.from(idFilterSet).join('\n');
  modeAllow.classList.toggle('active', idFilterMode === 'allow');
  modeBlock.classList.toggle('active', idFilterMode === 'block');
  modalOverlay.classList.remove('hidden');
});

modeAllow.addEventListener('click', () => {
  pendingFilterMode = 'allow';
  modeAllow.classList.add('active');
  modeBlock.classList.remove('active');
});

modeBlock.addEventListener('click', () => {
  pendingFilterMode = 'block';
  modeBlock.classList.add('active');
  modeAllow.classList.remove('active');
});

function closeModal(): void {
  modalOverlay.classList.add('hidden');
}

modalClose.addEventListener('click',  closeModal);
modalCancel.addEventListener('click', closeModal);

modalApply.addEventListener('click', () => {
  idFilterMode = pendingFilterMode;
  idFilterSet  = new Set(
    modalIds.value
      .split('\n')
      .map((l) => l.trim().toUpperCase())
      .filter((l) => /^[0-9A-F]{1,8}$/.test(l))
  );
  closeModal();
  applyAllFilters();
});

// Close modal on overlay click (outside the modal box)
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
```

- [ ] **Step 2: Also wire up the toast IPC channel in `main.ts`**

The renderer references `window.api.onToast` — add this to `preload.ts`:

In `app/preload.ts`, after the `onStatus` line inside the `api` object, add:

```typescript
  onToast: (cb: (msg: string) => void) => ipcRenderer.on('toast', (_e, m: string) => cb(m)),
```

And update the `CanDoAPI` interface in `src/protocol.ts` to add:

```typescript
  onToast(cb: (msg: string) => void): void;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd app
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add app/renderer.ts app/preload.ts app/src/protocol.ts
git commit -m "feat: renderer ID filter modal and toast IPC"
```

---

### Task 11: Integration Smoke Test

**Files:**
- No new files

- [ ] **Step 1: Run all tests one final time**

```bash
cd app
npx jest
```

Expected: All tests PASS.

- [ ] **Step 2: Build the app**

```bash
cd app
npm run build
```

Expected: TypeScript compiles with no errors. `dist/` directory contains `main.js`, `preload.js`, `renderer.js`, `src/`.

- [ ] **Step 3: Launch the app**

```bash
cd app
npm start
```

Expected: Electron window opens with dark theme. Top bar visible with PORT, SPEED, Connect, Open, Record, Clear. Filter bar visible. Empty frame log. Status bar shows "Disconnected / Closed / —".

- [ ] **Step 4: Test port listing**

Click ⟳ refresh button. Expected: port dropdown populates with available serial ports.

- [ ] **Step 5: Test connect flow (if device available)**

Select the CANable port. Click Connect. Expected: button changes to "Disconnect", status bar shows "Connected". Click Open. Expected: channel opens, button changes to "Close".

- [ ] **Step 6: Verify frame display (if device available)**

With channel open and CAN bus traffic present: frames appear in the table. Repeated identical frames increment COUNT. LAST SEEN updates. Auto-scroll keeps newest frame visible.

- [ ] **Step 7: Test filter**

Type a hex ID fragment in the filter input. Expected: non-matching rows hide. `showing N / total` updates.

- [ ] **Step 8: Test ID List modal**

Click "ID List…". Enter one or two hex IDs, toggle Allowlist/Blocklist, Apply. Expected: frame log filters accordingly.

- [ ] **Step 9: Test recording**

Click ⏺ Record. Save dialog appears. Choose a path. Expected: status bar shows "⏺ Recording → filename.csv". Click ⏹ Stop. Open the CSV in a text editor — header row present, one data row per received frame.

- [ ] **Step 10: Final commit**

```bash
git add -A
git commit -m "feat: complete CANdo Electron app"
```

---

## Notes

- `parseBuffer` returns the unconsumed tail each call; `SerialManager._handleData` replaces `this.buf` with the returned tail so partial frames survive across chunks.
- `cobsDecode` handles the overhead-byte-at-end case (the encoder always places a final overhead byte, so COBS-decode strips the trailing zero it would insert).
- The 2000-row cap removes rows by display index; `rowByKey` prevents duplicate keys, so the effective cap is on unique frame signatures, not raw arrivals.
- `import type` in `renderer.ts` ensures no CommonJS `require()` is emitted for types, which matters because the renderer runs in a browser context without Node.js globals.
