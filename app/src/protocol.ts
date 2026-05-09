// ── Packet type bytes ─────────────────────────────────────────────────────────
// Device → App
export const PKT_CAN_FRAME = 0x01; // [4B id LE][1B flags][1B dlc][N bytes data]
export const PKT_RESPONSE  = 0x02; // [1B status: 0x00=OK, 0xFF=KO]
export const PKT_HELLO     = 0x03; // (no payload) — handshake reply
export const PKT_CAPS      = 0x04; // [1B ver][1B num_speeds][1B caps_flags][N×4B rate_hz LE]

// App → Device
export const CMD_SET_SPEED = 0x01; // [1B speed_idx 0-7]
export const CMD_OPEN      = 0x02; // (no payload)
export const CMD_CLOSE     = 0x03; // (no payload)
export const CMD_TRANSMIT  = 0x04; // [4B id LE][1B flags][1B dlc][N bytes data]
export const CMD_HELLO     = 0x05; // (no payload) — handshake initiation

// ── Flags byte ────────────────────────────────────────────────────────────────
// bit 0: EXT — extended 29-bit ID
// bit 1: RTR — remote transmission request
// bit 2: FD  — CANFD frame format
// bit 3: BRS — bit rate switch (FD only)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CanFrame {
  seq:  number;
  ts:   number;
  id:   number;
  ext:  boolean;
  rtr:  boolean;
  fd:   boolean;
  brs:  boolean;
  dlc:  number;
  data: Uint8Array; // length = dlcToBytes(dlc)
}

export interface PortInfo {
  path:         string;
  manufacturer: string | undefined;
}

export type SpeedIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface AppStatus {
  connected:    boolean;
  channelOpen:  boolean;
  recording:    boolean;
  recordPath:   string | null;
  errorCount:   number;
  repeatActive: boolean;
}

export interface CapabilityInfo {
  fdSupported: boolean;
  ratesHz: number[];
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
  onToast(cb: (msg: string) => void):               void;
}

// ── CANFD DLC ─────────────────────────────────────────────────────────────────

const DLC_BYTES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

export function dlcToBytes(dlc: number): number {
  return DLC_BYTES[dlc] ?? 64;
}

// ── COBS ──────────────────────────────────────────────────────────────────────

// Encodes src using COBS. Returns encoded bytes WITHOUT the 0x00 delimiter.
export function cobsEncode(src: Buffer): Buffer {
  const dst = Buffer.alloc(src.length + 2);
  let out = 0;
  let codeIdx = out++;
  let run = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x00) {
      dst[codeIdx] = run;
      codeIdx = out++;
      run = 1;
    } else {
      dst[out++] = src[i];
      run++;
      if (run === 0xFF) {
        dst[codeIdx] = run;
        codeIdx = out++;
        run = 1;
      }
    }
  }
  dst[codeIdx] = run;
  return dst.slice(0, out);
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
  return Buffer.from(dst);
}

// ── Frame unpack ──────────────────────────────────────────────────────────────

// Wire format (after type byte is stripped):
//   [4B id LE][1B flags][1B dlc][N bytes data]  N = buf.length - 6
export function unpackFrame(buf: Buffer, seq: number, ts: number): CanFrame | null {
  if (buf.length < 6) return null;
  const id    = buf.readUInt32LE(0);
  const flags = buf[4];
  const dlc   = buf[5];
  const data  = new Uint8Array(buf.buffer, buf.byteOffset + 6, buf.length - 6);
  return {
    seq,
    ts,
    id,
    ext: (flags & 0x01) !== 0,
    rtr: (flags & 0x02) !== 0,
    fd:  (flags & 0x04) !== 0,
    brs: (flags & 0x08) !== 0,
    dlc,
    data,
  };
}

// ── Buffer parser ─────────────────────────────────────────────────────────────

// Scans buf for 0x00-delimited COBS packets. Dispatches on type byte:
//   PKT_CAN_FRAME → onFrame
//   PKT_RESPONSE  → onResponse(ok: boolean)
//   PKT_HELLO     → onHello()
//   PKT_CAPS      → onCaps(CapabilityInfo)
// Returns unconsumed tail (partial packet).
export function parseBuffer(
  buf: Buffer,
  seq: number,
  ts: number,
  onFrame: (f: CanFrame) => void,
  onResponse: (ok: boolean) => void,
  onHello?: () => void,
  onCaps?: (caps: CapabilityInfo) => void,
): Buffer {
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) {
      const chunk = buf.slice(start, i);
      start = i + 1;
      if (chunk.length === 0) continue;
      const decoded = cobsDecode(chunk);
      if (decoded === null || decoded.length === 0) continue;
      const type = decoded[0];
      if (type === PKT_CAN_FRAME) {
        const frame = unpackFrame(decoded.slice(1), seq, ts);
        if (frame) onFrame(frame);
      } else if (type === PKT_RESPONSE && decoded.length >= 2) {
        onResponse(decoded[1] === 0x00);
      } else if (type === PKT_HELLO) {
        onHello?.();
      } else if (type === PKT_CAPS && decoded.length >= 4) {
        const numSpeeds = decoded[2];
        const capsFlags = decoded[3];
        const ratesHz: number[] = [];
        for (let j = 0; j < numSpeeds && 4 + (j + 1) * 4 <= decoded.length; j++) {
          ratesHz.push(decoded.readUInt32LE(4 + j * 4));
        }
        onCaps?.({ fdSupported: (capsFlags & 0x01) !== 0, ratesHz });
      }
    }
  }
  return buf.slice(start);
}
