import type { CanFrame, AppStatus, SpeedIndex } from './src/protocol';
import type {
  CanDefinitionFile, CanMessageDefinition, CanFieldDefinition,
  NumberFieldDefinition, BitFieldDefinition, BitSignalDefinition,
  StringFieldDefinition,
} from './src/canDefinitions';

// ── Inline helpers (no Node.js imports allowed in renderer) ───────────────────

const DLC_BYTES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
function dlcToBytes(dlc: number): number { return DLC_BYTES[dlc] ?? 64; }

function formatTxHex(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/gi, '');
  const pairs: string[] = [];
  for (let i = 0; i < hex.length; i += 2) pairs.push(hex.slice(i, i + 2));
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 8) lines.push(pairs.slice(i, i + 8).join(' '));
  return lines.join('\n');
}

// ── Inline decode logic ────────────────────────────────────────────────────────

type ByteOrder = 'little' | 'big';

function extractBitsLE(data: Uint8Array, startByte: number, startBit: number, bitLen: number): bigint {
  let result = 0n;
  for (let i = 0; i < bitLen; i++) {
    const absBit = startByte * 8 + startBit + i;
    const byteIdx = absBit >> 3;
    const bitIdx  = absBit & 7;
    if (byteIdx < data.length) result |= BigInt((data[byteIdx] >> bitIdx) & 1) << BigInt(i);
  }
  return result;
}

function extractBitsBE(data: Uint8Array, startByte: number, startBit: number, bitLen: number): bigint {
  let result = 0n;
  let byteIdx = startByte;
  let bitIdx  = startBit;
  for (let i = bitLen - 1; i >= 0; i--) {
    if (byteIdx < data.length) result |= BigInt((data[byteIdx] >> bitIdx) & 1) << BigInt(i);
    if (bitIdx === 0) { byteIdx++; bitIdx = 7; } else { bitIdx--; }
  }
  return result;
}

function toSigned(v: bigint, bits: number): bigint {
  const sign = 1n << BigInt(bits - 1);
  return (v & sign) === 0n ? v : v - (1n << BigInt(bits));
}

function bigIntToNumber(v: bigint): number | null {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(v);
}

function fmtScaled(v: number, unit?: string): string {
  const t = Number.isInteger(v) ? String(v)
    : v.toFixed(4).replace(/\.?0+$/, '');
  return unit ? `${t} ${unit}` : t;
}

interface DecodedVal { name: string; value: string }

function decodeFrame(
  frame: Pick<CanFrame, 'id' | 'dlc' | 'data'>,
  defs: CanDefinitionFile | null,
): { msgName: string; values: DecodedVal[] } | null {
  if (!defs) return null;
  const msg = defs.messages.find((m) => (frame.id & m.mask) === (m.id & m.mask));
  if (!msg) return null;
  return { msgName: msg.name, values: msg.fields.map((f) => decodeField(frame, f)) };
}

function decodeField(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  field: CanFieldDefinition,
): DecodedVal {
  if (field.kind === 'number') return decodeNumber(frame, field);
  if (field.kind === 'string') return decodeString(frame, field);
  return decodeBits(frame, field);
}

function numFieldEndByte(f: NumberFieldDefinition): number {
  const startBit = f.startBit ?? (f.byteOrder === 'big' ? 7 : 0);
  const bitLen   = f.bitLength ?? ((f.byteLength ?? 1) * 8);
  if (f.byteOrder === 'little') return (f.startByte * 8 + startBit + bitLen - 1) >> 3;
  const rem = Math.max(0, bitLen - (startBit + 1));
  return f.startByte + (rem === 0 ? 0 : Math.ceil(rem / 8));
}

function decodeNumber(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  f: NumberFieldDefinition,
): DecodedVal {
  const startBit = f.startBit ?? (f.byteOrder === 'big' ? 7 : 0);
  const bitLen   = f.bitLength ?? ((f.byteLength ?? 1) * 8);
  const endByte  = numFieldEndByte(f);
  if (f.startByte < 0 || bitLen <= 0 || endByte >= frame.dlc) return { name: f.name, value: 'n/a' };
  const rawUnsigned = f.byteOrder === 'little'
    ? extractBitsLE(frame.data, f.startByte, startBit, bitLen)
    : extractBitsBE(frame.data, f.startByte, startBit, bitLen);
  let raw = rawUnsigned;
  if (f.signed) raw = toSigned(rawUnsigned, bitLen);
  const hexStr  = rawUnsigned.toString(16).toUpperCase().padStart(Math.ceil(bitLen / 4), '0');
  const rawText = f.base === 'hex' ? `0x${hexStr}` : raw.toString();
  if ((f.scale ?? 1) !== 1 || (f.offset ?? 0) !== 0) {
    const n = bigIntToNumber(raw);
    if (n !== null) return { name: f.name, value: fmtScaled(n * (f.scale ?? 1) + (f.offset ?? 0), f.unit) };
  }
  return { name: f.name, value: rawText + (f.unit ? ` ${f.unit}` : '') };
}

function decodeBits(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  f: BitFieldDefinition,
): DecodedVal {
  if (f.byteIndex < 0 || f.byteIndex >= frame.dlc) return { name: f.name, value: 'n/a' };
  const byte = frame.data[f.byteIndex];
  const parts = [...f.bits]
    .sort((a, b) => a.bit - b.bit)
    .map((b) => {
      const set = ((byte >> b.bit) & 1) === 1;
      return `${b.name}=${(b.activeHigh === false ? !set : set) ? 1 : 0}`;
    });
  return { name: f.name, value: parts.join(' ') };
}

function decodeString(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  f: StringFieldDefinition,
): DecodedVal {
  if (f.startByte >= frame.dlc) return { name: f.name, value: 'n/a' };
  const maxBytes = Math.min(f.maxLength, frame.dlc - f.startByte);
  const bytes    = Array.from(frame.data.slice(f.startByte, f.startByte + maxBytes));
  const nullIdx  = f.nullTerminated !== false ? bytes.indexOf(0) : -1;
  const chars    = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes;
  const str = chars
    .map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)
    .join('');
  return { name: f.name, value: `"${str}"` };
}

// ── Global state ───────────────────────────────────────────────────────────────

declare global {
  interface Window {
    api: {
      listPorts(): Promise<{ path: string; manufacturer?: string; friendlyName?: string; isTarget?: boolean }[]>;
      connect(path: string): Promise<void>;
      disconnect(): Promise<void>;
      setSpeed(index: number): Promise<'OK' | 'KO'>;
      openChannel(): Promise<'OK' | 'KO'>;
      closeChannel(): Promise<'OK' | 'KO'>;
      startLogging(): Promise<string>;
      stopLogging(): Promise<void>;
      transmitFrame(req: { id: number; ext: boolean; rtr: boolean; dlc: number; dataHex: string }): Promise<void>;
      startRepeat(req: { id: number; ext: boolean; rtr: boolean; dlc: number; dataHex: string }, ms: number, count: number): Promise<void>;
      stopRepeat(): Promise<void>;
      loadDefinitions(): Promise<CanDefinitionFile>;
      saveDefinitions(defs: CanDefinitionFile): Promise<string>;
      setDefinitions(defs: CanDefinitionFile | null): Promise<void>;
      onFrame(cb: (ev: { frame: CanFrame; decoded: { msgName: string; values: {name:string;value:string}[] } | null }) => void): void;
      onStatus(cb: (s: AppStatus) => void): void;
      onToast(cb: (msg: string) => void): void;
      onDefinitions(cb: (defs: CanDefinitionFile | null) => void): void;
    };
  }
}

let appStatus: AppStatus = {
  connected: false, channelOpen: false,
  recording: false, recordPath: null, errorCount: 0, repeatActive: false,
};
let totalFrames = 0;
let activeDefinitions: CanDefinitionFile | null = null;

// ── Element refs ───────────────────────────────────────────────────────────────

const portSelect   = document.getElementById('port-select')!   as HTMLSelectElement;
const speedSelect  = document.getElementById('speed-select')!  as HTMLSelectElement;
const connectBtn   = document.getElementById('connect-btn')!   as HTMLButtonElement;
const channelBtn   = document.getElementById('channel-btn')!   as HTMLButtonElement;
const recordBtn    = document.getElementById('record-btn')!    as HTMLButtonElement;
const refreshBtn   = document.getElementById('refresh-btn')!   as HTMLButtonElement;
const clearBtn     = document.getElementById('clear-btn')!     as HTMLButtonElement;
const frameCountEl = document.getElementById('frame-count')!;
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

// Transmit elements
const txId         = document.getElementById('tx-id')!         as HTMLInputElement;
const txExt        = document.getElementById('tx-ext')!        as HTMLInputElement;
const txRtr        = document.getElementById('tx-rtr')!        as HTMLInputElement;
const txDlc        = document.getElementById('tx-dlc')!        as HTMLSelectElement;
const txData       = document.getElementById('tx-data')!       as HTMLTextAreaElement;
const txSend       = document.getElementById('tx-send')!       as HTMLButtonElement;
const txRepeatChk  = document.getElementById('tx-repeat-chk')! as HTMLInputElement;
const txInterval   = document.getElementById('tx-interval')!   as HTMLInputElement;
const txCount      = document.getElementById('tx-count')!      as HTMLInputElement;
const txToggle     = document.getElementById('tx-toggle')!     as HTMLButtonElement;

// Definition editor elements
const defOpenBtn      = document.getElementById('def-open-btn')!      as HTMLButtonElement;
const defActiveLabel  = document.getElementById('def-active-label')!;
const defOverlay      = document.getElementById('def-overlay')!;
const defDialogClose  = document.getElementById('def-dialog-close')!  as HTMLButtonElement;
const defLoadBtn      = document.getElementById('def-load-btn')!      as HTMLButtonElement;
const defSaveBtn      = document.getElementById('def-save-btn')!      as HTMLButtonElement;
const defClearBtn     = document.getElementById('def-clear-btn')!     as HTMLButtonElement;
const defFileName     = document.getElementById('def-file-name')!     as HTMLInputElement;
const defMsgList      = document.getElementById('def-msg-list')!;
const defMsgAdd       = document.getElementById('def-msg-add')!       as HTMLButtonElement;
const defMsgDel       = document.getElementById('def-msg-del')!       as HTMLButtonElement;
const defDetailEmpty  = document.getElementById('def-detail-empty')!;
const defMsgEditor    = document.getElementById('def-msg-editor')!;
const defEditName     = document.getElementById('def-edit-name')!     as HTMLInputElement;
const defEditId       = document.getElementById('def-edit-id')!       as HTMLInputElement;
const defEditMask     = document.getElementById('def-edit-mask')!     as HTMLInputElement;
const defEditDesc     = document.getElementById('def-edit-desc')!     as HTMLInputElement;
const defAddNumBtn    = document.getElementById('def-add-num-btn')!   as HTMLButtonElement;
const defAddBitsBtn   = document.getElementById('def-add-bits-btn')!  as HTMLButtonElement;
const defFieldList    = document.getElementById('def-field-list')!;
const defFieldEditor  = document.getElementById('def-field-editor')!;
const defFieldBack    = document.getElementById('def-field-back')!    as HTMLButtonElement;
const defFieldEdTitle = document.getElementById('def-field-editor-title')!;
const defFieldForm    = document.getElementById('def-field-form')!;
const defFieldSave    = document.getElementById('def-field-save')!    as HTMLButtonElement;
const defFieldCancel  = document.getElementById('def-field-cancel')!  as HTMLButtonElement;

// ── Port list ─────────────────────────────────────────────────────────────────

async function refreshPorts(): Promise<void> {
  try {
    const ports = await window.api.listPorts();
    portSelect.innerHTML = '';
    if (ports.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '(no ports found)';
      portSelect.appendChild(opt);
      return;
    }
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.path;
      const star = p.isTarget ? '★ ' : '';
      const label = p.friendlyName || (p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path);
      opt.textContent = star + label;
      portSelect.appendChild(opt);
      if (p.isTarget && !portSelect.value) portSelect.value = p.path;
    }
  } catch (err: any) {
    showToast(`Port list error: ${err.message ?? String(err)}`);
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
  } catch (err: unknown) {
    showToast((err as Error).message ?? String(err));
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
  } catch (err: unknown) {
    showToast((err as Error).message ?? String(err));
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
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg !== 'Cancelled') showToast(msg || String(err));
  }
  recordBtn.disabled = false;
});

// ── Refresh + Clear ───────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', refreshPorts);

clearBtn.addEventListener('click', () => {
  rowByKey.clear();
  rowByDisplayIdx.clear();
  frameDataByKey.clear();
  frameLog.innerHTML = '';
  totalFrames = 0;
  frameCountEl.textContent = '0';
  updateFilterCount();
});

// ── Status updates ────────────────────────────────────────────────────────────

const SPEED_LABELS: Record<number, string> = {
  1: '1.000 Mbps', 2: '2.000 Mbps', 3: '~3.0 Mbps', 4: '4.000 Mbps',
  5: '~4.9 Mbps',  6: '~5.8 Mbps',  7: '~7.1 Mbps', 8: '8.000 Mbps',
};

window.api.onStatus((s) => {
  appStatus = s;

  connectBtn.disabled = false;
  connectBtn.textContent = s.connected ? 'Disconnect' : 'Connect';
  connectBtn.classList.toggle('disconnecting', s.connected);

  channelBtn.disabled = !s.connected;
  channelBtn.textContent = s.channelOpen ? 'Close' : 'Open';
  channelBtn.classList.toggle('open', s.channelOpen);

  recordBtn.disabled = !s.channelOpen;
  recordBtn.textContent = s.recording ? '⏹ Stop' : '⏺ Record';
  recordBtn.classList.toggle('recording', s.recording);

  // Transmit panel
  const txEnabled = s.connected && s.channelOpen;
  txSend.disabled     = !txEnabled || s.repeatActive;
  txToggle.disabled   = !txEnabled || !txRepeatChk.checked;
  if (!s.repeatActive && txToggle.classList.contains('active')) {
    txToggle.textContent = 'Start';
    txToggle.classList.remove('active');
    txSend.disabled = !txEnabled;
  }

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

function showToast(msg: string, kind: 'error' | 'info' = 'error'): void {
  const el = document.createElement('div');
  el.className = kind === 'info' ? 'toast info' : 'toast';
  el.textContent = msg;
  toastCont.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

window.api.onToast((msg) => showToast(msg));

// ── Transmit panel ────────────────────────────────────────────────────────────

txDlc.addEventListener('change', () => {
  const byteCount = dlcToBytes(parseInt(txDlc.value, 10));
  txData.value = byteCount > 0 ? formatTxHex(Array(byteCount).fill('00').join('')) : '';
  txData.rows  = Math.max(1, Math.ceil(byteCount / 8));
});

txData.addEventListener('input', () => {
  const sel       = txData.selectionStart ?? txData.value.length;
  const hexBefore = (txData.value.substring(0, sel).match(/[0-9a-fA-F]/gi) ?? []).length;
  const formatted = formatTxHex(txData.value);
  txData.value    = formatted;
  // Restore cursor after the hexBefore-th hex digit in the formatted string
  let count  = 0;
  let newPos = formatted.length;
  for (let i = 0; i < formatted.length; i++) {
    if (/[0-9a-fA-F]/i.test(formatted[i])) {
      count++;
      if (count === hexBefore) { newPos = i + 1; break; }
    }
  }
  if (hexBefore === 0) newPos = 0;
  txData.setSelectionRange(newPos, newPos);
});

txRepeatChk.addEventListener('change', () => {
  txInterval.disabled = !txRepeatChk.checked;
  txCount.disabled    = !txRepeatChk.checked;
  txToggle.disabled   = !txRepeatChk.checked || !(appStatus.connected && appStatus.channelOpen);
});

txSend.addEventListener('click', async () => {
  const req = buildTxRequest();
  if (!req) return;
  try {
    await window.api.transmitFrame(req);
  } catch (err: unknown) {
    showToast((err as Error).message ?? String(err));
  }
});

txToggle.addEventListener('click', async () => {
  if (appStatus.repeatActive) {
    await window.api.stopRepeat();
    txToggle.textContent = 'Start';
    txToggle.classList.remove('active');
    txSend.disabled = !(appStatus.connected && appStatus.channelOpen);
  } else {
    const req = buildTxRequest();
    if (!req) return;
    const ms    = Math.max(1, parseInt(txInterval.value, 10) || 100);
    const count = Math.max(0, parseInt(txCount.value, 10) || 0);
    try {
      await window.api.startRepeat(req, ms, count);
      txToggle.textContent = 'Stop';
      txToggle.classList.add('active');
      txSend.disabled = true;
    } catch (err: unknown) {
      showToast((err as Error).message ?? String(err));
    }
  }
});

function buildTxRequest(): { id: number; ext: boolean; rtr: boolean; dlc: number; dataHex: string } | null {
  const idStr = txId.value.trim();
  if (!idStr) { showToast('Enter a CAN ID'); return null; }
  const id = parseInt(idStr, 16);
  if (isNaN(id)) { showToast('CAN ID must be hex'); return null; }
  const ext = txExt.checked;
  const rtr = txRtr.checked;
  const dlc = parseInt(txDlc.value, 10);
  const dataHex = txData.value.replace(/[^0-9a-fA-F]/g, '');
  const required = dlcToBytes(dlc);
  if (!rtr && dataHex.length / 2 < required) {
    showToast(`DLC ${dlc} requires ${required} bytes but only ${Math.floor(dataHex.length / 2)} provided`);
    return null;
  }
  return { id, ext, rtr, dlc, dataHex };
}

// ── Frame table ───────────────────────────────────────────────────────────────

const MAX_ROWS = 2000;
const rowByKey:        Map<string, HTMLElement> = new Map();
const rowByDisplayIdx: Map<number, HTMLElement> = new Map();
const frameDataByKey:  Map<string, Pick<CanFrame, 'id'|'dlc'|'data'>> = new Map();
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

function formatTs(ms: number): string { return (ms / 1000).toFixed(3); }

function formatId(f: CanFrame): string {
  return f.ext
    ? f.id.toString(16).toUpperCase().padStart(8, '0')
    : f.id.toString(16).toUpperCase().padStart(4, '0');
}

function updateDecodedEl(row: HTMLElement, frameData: Pick<CanFrame, 'id'|'dlc'|'data'>): void {
  const el = row.querySelector('.frame-decoded') as HTMLElement | null;
  if (!el) return;
  const decoded = decodeFrame(frameData, activeDefinitions);
  if (decoded) {
    el.textContent = `${decoded.msgName}: ${decoded.values.map((v) => `${v.name}=${v.value}`).join('  |  ')}`;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function refreshDecodedRows(): void {
  for (const [key, row] of rowByKey) {
    const fd = frameDataByKey.get(key);
    if (fd) updateDecodedEl(row, fd);
  }
}

window.api.onFrame((ev) => {
  const frame = ev.frame;
  totalFrames++;
  frameCountEl.textContent = String(totalFrames);

  const key      = frameKey(frame);
  const existing = rowByKey.get(key);

  if (existing) {
    const countEl = existing.querySelector('.count-val')!;
    const tsEl    = existing.querySelector('.col-ts')!;
    const next    = parseInt(countEl.textContent ?? '1', 10) + 1;
    const wrapper = existing.querySelector('.count-cell')!;
    wrapper.innerHTML = `<span class="count-badge"><span class="count-val">${next}</span></span>`;
    tsEl.textContent  = formatTs(frame.ts);
    // Update decoded in case the data changed (count-keyed frames share data, but update anyway)
    updateDecodedEl(existing, frame);
  } else {
    const row = document.createElement('div');
    row.className    = 'frame-row' + (frame.ext ? ' ext' : '') + (frame.rtr ? ' rtr' : '');
    row.dataset['key'] = key;

    const flagParts: string[] = [];
    if (frame.ext) flagParts.push('<span class="col-flags-ext">EXT</span>');
    if (frame.rtr) flagParts.push('<span class="col-flags-rtr">RTR</span>');
    if (frame.fd)  flagParts.push('<span class="col-flags-fd">FD</span>');
    if (frame.brs) flagParts.push('<span class="col-flags-brs">BRS</span>');
    const flagsHtml = flagParts.join('');

    row.innerHTML = `
      <span class="col-seq">${String(nextDisplayIdx).padStart(3, '0')}</span>
      <span class="col-ts">${formatTs(frame.ts)}</span>
      <span class="col-id">${formatId(frame)}</span>
      <span class="col-flags">${flagsHtml}</span>
      <span class="col-dlc">${frame.dlc > 8 ? `${frame.dlc} [${dlcToBytes(frame.dlc)}B]` : frame.dlc}</span>
      <span class="count-cell"><span class="count-muted"><span class="count-val">1</span></span></span>
      <span class="col-data">${formatDataHex(frame)}</span>
      <div class="frame-decoded hidden"></div>
    `;

    rowByKey.set(key, row);
    rowByDisplayIdx.set(nextDisplayIdx, row);
    frameDataByKey.set(key, { id: frame.id, dlc: frame.dlc, data: frame.data });
    nextDisplayIdx++;

    // Apply decoded (from main-process pre-computed or inline)
    const decoded = ev.decoded ?? decodeFrame(frame, activeDefinitions);
    if (decoded) {
      const el = row.querySelector('.frame-decoded') as HTMLElement;
      el.textContent = `${decoded.msgName}: ${decoded.values.map((v) => `${v.name}=${v.value}`).join('  |  ')}`;
      el.classList.remove('hidden');
    }

    frameLog.appendChild(row);
    applyFilterToRow(row);

    if (rowByKey.size > MAX_ROWS) {
      const oldestIdx = nextDisplayIdx - rowByKey.size;
      const oldRow    = rowByDisplayIdx.get(oldestIdx);
      if (oldRow) {
        rowByKey.delete(oldRow.dataset['key']!);
        rowByDisplayIdx.delete(oldestIdx);
        frameDataByKey.delete(oldRow.dataset['key']!);
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
  if (!userScrolledUp) frameLog.scrollTop = frameLog.scrollHeight;
}

// ── Filter ────────────────────────────────────────────────────────────────────

let filterText    = '';
let idFilterMode: 'allow' | 'block' = 'allow';
let idFilterSet:  Set<string> = new Set();

function rowMatchesFilter(row: HTMLElement): boolean {
  const idTxt   = (row.querySelector('.col-id')?.textContent   ?? '').toLowerCase();
  const dataTxt = (row.querySelector('.col-data')?.textContent ?? '').toLowerCase();

  if (filterText && !idTxt.includes(filterText) && !dataTxt.includes(filterText.replace(/ /g, ''))) {
    return false;
  }
  if (idFilterSet.size > 0) {
    const inSet = idFilterSet.has(idTxt.toUpperCase());
    if (idFilterMode === 'allow' && !inSet) return false;
    if (idFilterMode === 'block' &&  inSet) return false;
  }
  return true;
}

function applyFilterToRow(row: HTMLElement): void {
  row.style.display = rowMatchesFilter(row) ? '' : 'none';
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

function closeModal(): void { modalOverlay.classList.add('hidden'); }

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

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ── Definition Editor ─────────────────────────────────────────────────────────

let draftDefs: CanDefinitionFile = { version: 1, name: '', messages: [] };
let selectedMsgIdx  = -1;
let editingFieldIdx = -1;  // -1 = new field
let editingFieldKind: 'number' | 'bits' | 'string' = 'number';

function openDefEditor(): void {
  draftDefs = activeDefinitions
    ? JSON.parse(JSON.stringify(activeDefinitions))
    : { version: 1, name: '', messages: [] };
  defFileName.value = draftDefs.name;
  selectedMsgIdx = -1;
  renderMsgList();
  showMsgEditorPane(false);
  defOverlay.classList.remove('hidden');
}

function closeDefEditor(): void {
  defOverlay.classList.add('hidden');
}

defOpenBtn.addEventListener('click', openDefEditor);
defDialogClose.addEventListener('click', closeDefEditor);
defOverlay.addEventListener('click', (e) => { if (e.target === defOverlay) closeDefEditor(); });

defFileName.addEventListener('input', () => {
  draftDefs.name = defFileName.value.trim();
  pushDraftDefs();
});

defLoadBtn.addEventListener('click', async () => {
  try {
    const loaded = await window.api.loadDefinitions();
    draftDefs = JSON.parse(JSON.stringify(loaded));
    defFileName.value = draftDefs.name;
    selectedMsgIdx = -1;
    renderMsgList();
    showMsgEditorPane(false);
    showToast(`Loaded: ${draftDefs.name || 'definitions'}`, 'info');
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg !== 'Cancelled') showToast(msg || String(err));
  }
});

defSaveBtn.addEventListener('click', async () => {
  // Flush any in-progress message form edits
  flushMsgFormEdits();
  try {
    const path = await window.api.saveDefinitions(draftDefs);
    const fname = path.split(/[/\\]/).pop()!;
    showToast(`Saved: ${fname}`, 'info');
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg !== 'Cancelled') showToast(msg || String(err));
  }
});

defClearBtn.addEventListener('click', () => {
  draftDefs = { version: 1, name: '', messages: [] };
  defFileName.value = '';
  selectedMsgIdx = -1;
  renderMsgList();
  showMsgEditorPane(false);
  pushDraftDefs();
});

function pushDraftDefs(): void {
  window.api.setDefinitions(draftDefs.messages.length > 0 ? draftDefs : null);
}

window.api.onDefinitions((defs) => {
  activeDefinitions = defs;
  defActiveLabel.textContent = defs ? `[${defs.name || 'definitions loaded'}]` : '';
  refreshDecodedRows();
});

// Message list
function renderMsgList(): void {
  defMsgList.innerHTML = '';
  draftDefs.messages.forEach((msg, i) => {
    const item = document.createElement('div');
    item.className = 'def-msg-item' + (i === selectedMsgIdx ? ' selected' : '');
    item.innerHTML = `
      <div>${escHtml(msg.name || '(unnamed)')}</div>
      <div class="def-msg-item-sub">ID: 0x${msg.id.toString(16).toUpperCase()}  Mask: 0x${msg.mask.toString(16).toUpperCase()}</div>
    `;
    item.addEventListener('click', () => selectMsg(i));
    defMsgList.appendChild(item);
  });
}

function selectMsg(idx: number): void {
  // Flush previous edits
  if (selectedMsgIdx >= 0) flushMsgFormEdits();
  selectedMsgIdx = idx;
  renderMsgList();
  populateMsgForm();
  showMsgEditorPane(true);
  showFieldEditorPane(false);
}

function showMsgEditorPane(show: boolean): void {
  defDetailEmpty.style.display = show ? 'none' : '';
  defMsgEditor.classList.toggle('hidden', !show);
}

function populateMsgForm(): void {
  const msg = draftDefs.messages[selectedMsgIdx];
  if (!msg) return;
  defEditName.value = msg.name;
  defEditId.value   = msg.id.toString(16).toUpperCase();
  defEditMask.value = msg.mask.toString(16).toUpperCase();
  defEditDesc.value = msg.description ?? '';
  renderFieldList();
}

function flushMsgFormEdits(): void {
  if (selectedMsgIdx < 0 || selectedMsgIdx >= draftDefs.messages.length) return;
  const msg = draftDefs.messages[selectedMsgIdx];
  msg.name        = defEditName.value.trim();
  msg.id          = parseInt(defEditId.value, 16) || 0;
  msg.mask        = parseInt(defEditMask.value, 16) || 0x7FF;
  msg.description = defEditDesc.value.trim() || undefined;
  renderMsgList();
  pushDraftDefs();
}

[defEditName, defEditId, defEditMask, defEditDesc].forEach((el) =>
  el.addEventListener('input', flushMsgFormEdits)
);

defMsgAdd.addEventListener('click', () => {
  if (selectedMsgIdx >= 0) flushMsgFormEdits();
  const newMsg: CanMessageDefinition = { name: 'New Message', id: 0, mask: 0x7FF, fields: [] };
  draftDefs.messages.push(newMsg);
  selectMsg(draftDefs.messages.length - 1);
  pushDraftDefs();
});

defMsgDel.addEventListener('click', () => {
  if (selectedMsgIdx < 0) return;
  draftDefs.messages.splice(selectedMsgIdx, 1);
  selectedMsgIdx = Math.min(selectedMsgIdx, draftDefs.messages.length - 1);
  renderMsgList();
  if (selectedMsgIdx >= 0) {
    selectMsg(selectedMsgIdx);
  } else {
    showMsgEditorPane(false);
  }
  pushDraftDefs();
});

// Field list
function fieldByteRange(field: CanFieldDefinition): [number, number] {
  if (field.kind === 'number') return [field.startByte, numFieldEndByte(field)];
  if (field.kind === 'string') return [field.startByte, field.startByte + field.maxLength - 1];
  return [field.byteIndex, field.byteIndex];
}

function renderFieldList(): void {
  defFieldList.innerHTML = '';
  const msg = draftDefs.messages[selectedMsgIdx];
  if (!msg) return;

  // Display sorted by start byte; orig index (fi) is preserved for edit/delete
  const sorted = msg.fields
    .map((field, fi) => ({ field, fi }))
    .sort((a, b) => fieldByteRange(a.field)[0] - fieldByteRange(b.field)[0]);

  const ranges = sorted.map(({ field }) => fieldByteRange(field));
  const overlapping = ranges.map((r, i) =>
    ranges.some((r2, j) => j !== i && r[0] <= r2[1] && r2[0] <= r[1])
  );

  sorted.forEach(({ field, fi }, di) => {
    const item = document.createElement('div');
    item.className = 'def-field-item' + (overlapping[di] ? ' overlap' : '');
    const meta = fieldMeta(field);
    item.innerHTML = `
      <div class="def-field-info">
        <div class="def-field-name">${escHtml(field.name || '(unnamed)')} <span style="color:#8b949e;font-size:10px">[${field.kind}]</span></div>
        <div class="def-field-meta">${escHtml(meta)}</div>
      </div>
      <div class="def-field-actions">
        <button class="def-field-edit-btn">Edit</button>
        <button class="def-field-del-btn">×</button>
      </div>
    `;
    item.querySelector('.def-field-edit-btn')!.addEventListener('click', () => openFieldEditor(fi));
    item.querySelector('.def-field-del-btn')!.addEventListener('click', () => deleteField(fi));
    defFieldList.appendChild(item);
  });
}

function fieldMeta(field: CanFieldDefinition): string {
  if (field.kind === 'number') {
    const f = field as NumberFieldDefinition;
    const startBit    = f.startBit ?? (f.byteOrder === 'big' ? 7 : 0);
    const bitLen      = f.bitLength ?? ((f.byteLength ?? 1) * 8);
    const defStartBit = f.byteOrder === 'big' ? 7 : 0;
    const bitPart     = startBit !== defStartBit ? ` bit ${startBit},` : ',';
    const lenPart     = bitLen % 8 === 0 ? `${bitLen / 8}B` : `${bitLen}b`;
    return `byte ${f.startByte}${bitPart} ${lenPart}, ${f.byteOrder}, ${f.signed ? 'signed' : 'unsigned'}${f.scale && f.scale !== 1 ? `, ×${f.scale}` : ''}${f.unit ? ` [${f.unit}]` : ''}`;
  }
  if (field.kind === 'string') {
    const f = field as StringFieldDefinition;
    return `byte ${f.startByte}, len ${f.maxLength}${f.nullTerminated !== false ? ', null-term' : ''}`;
  }
  const f = field as BitFieldDefinition;
  return `byte ${f.byteIndex}, bits: ${f.bits.map((b) => `${b.bit}=${b.name}`).join(', ')}`;
}

function deleteField(fi: number): void {
  const msg = draftDefs.messages[selectedMsgIdx];
  if (!msg) return;
  msg.fields.splice(fi, 1);
  renderFieldList();
  pushDraftDefs();
}

const defAddStrBtn = document.getElementById('def-add-str-btn')! as HTMLButtonElement;

defAddNumBtn.addEventListener('click',  () => openFieldEditor(-1, 'number'));
defAddBitsBtn.addEventListener('click', () => openFieldEditor(-1, 'bits'));
defAddStrBtn.addEventListener('click',  () => openFieldEditor(-1, 'string'));

// Field editor
function showFieldEditorPane(show: boolean): void {
  defFieldEditor.classList.toggle('hidden', !show);
  defMsgEditor.style.visibility = show ? 'hidden' : '';
}

function openFieldEditor(fi: number, kind?: 'number' | 'bits' | 'string'): void {
  const msg = draftDefs.messages[selectedMsgIdx];
  if (!msg) return;
  editingFieldIdx  = fi;
  editingFieldKind = fi >= 0 ? (msg.fields[fi].kind as 'number' | 'bits' | 'string') : (kind ?? 'number');
  defFieldEdTitle.textContent = fi >= 0 ? 'Edit Field' : 'Add Field';
  buildFieldForm(fi >= 0 ? msg.fields[fi] : null);
  showFieldEditorPane(true);
}

defFieldBack.addEventListener('click', () => {
  showFieldEditorPane(false);
  renderFieldList();
});

defFieldCancel.addEventListener('click', () => {
  showFieldEditorPane(false);
  renderFieldList();
});

defFieldSave.addEventListener('click', () => {
  const msg = draftDefs.messages[selectedMsgIdx];
  if (!msg) return;
  const field = readFieldForm();
  if (!field) return;
  if (editingFieldIdx >= 0) {
    msg.fields[editingFieldIdx] = field;
  } else {
    msg.fields.push(field);
  }
  pushDraftDefs();
  showFieldEditorPane(false);
  renderFieldList();
});

function buildFieldForm(existing: CanFieldDefinition | null): void {
  defFieldForm.innerHTML = '';
  const kind = editingFieldKind;

  if (kind === 'number') {
    const f        = existing as NumberFieldDefinition | null;
    const byteOrd  = f?.byteOrder ?? 'little';
    const defSb    = byteOrd === 'big' ? 7 : 0;
    const effSb    = f?.startBit ?? defSb;
    const bitLen   = f?.bitLength ?? ((f?.byteLength ?? 1) * 8);
    // Show in bytes mode when loaded from old byteLength-only field, otherwise bits
    const showBytes = f !== null && f.byteLength !== undefined && f.bitLength === undefined && bitLen % 8 === 0;
    const lenVal    = showBytes ? bitLen / 8 : bitLen;
    defFieldForm.innerHTML = `
      <div class="def-form-row"><label>Name</label>
        <input type="text" id="ff-name" value="${escHtml(f?.name ?? '')}" style="flex:1" />
      </div>
      <div class="def-form-row"><label>Start Byte</label>
        <input type="number" id="ff-start" value="${f?.startByte ?? 0}" min="0" max="63" style="width:60px" />
        <label>Start Bit</label>
        <input type="number" id="ff-startbit" value="${effSb}" min="0" max="7" style="width:60px" />
      </div>
      <div class="def-form-row"><label>Length</label>
        <input type="number" id="ff-len" value="${lenVal}" min="1" max="512" style="width:80px" />
        <select id="ff-lenunit">
          <option value="bits"${!showBytes ? ' selected' : ''}>Bits</option>
          <option value="bytes"${showBytes ? ' selected' : ''}>Bytes</option>
        </select>
      </div>
      <div class="def-form-row"><label>Byte Order</label>
        <select id="ff-order">
          <option value="little"${byteOrd === 'little' ? ' selected' : ''}>Little Endian</option>
          <option value="big"${byteOrd === 'big' ? ' selected' : ''}>Big Endian</option>
        </select>
      </div>
      <div class="def-form-row"><label>Signed</label>
        <input type="checkbox" id="ff-signed"${f?.signed ? ' checked' : ''} />
      </div>
      <div class="def-form-row"><label>Scale</label>
        <input type="number" id="ff-scale" value="${f?.scale ?? 1}" step="any" style="width:100px" />
        <label>Offset</label>
        <input type="number" id="ff-offset" value="${f?.offset ?? 0}" step="any" style="width:100px" />
      </div>
      <div class="def-form-row"><label>Display Base</label>
        <select id="ff-base">
          <option value="dec"${(f?.base ?? 'dec') === 'dec' ? ' selected' : ''}>Decimal</option>
          <option value="hex"${f?.base === 'hex' ? ' selected' : ''}>Hex</option>
        </select>
      </div>
      <div class="def-form-row"><label>Unit</label>
        <input type="text" id="ff-unit" value="${escHtml(f?.unit ?? '')}" style="width:100px" />
      </div>
    `;
  } else if (kind === 'string') {
    const f = existing as StringFieldDefinition | null;
    defFieldForm.innerHTML = `
      <div class="def-form-row"><label>Name</label>
        <input type="text" id="ff-name" value="${escHtml(f?.name ?? '')}" style="flex:1" />
      </div>
      <div class="def-form-row"><label>Start Byte</label>
        <input type="number" id="ff-start" value="${f?.startByte ?? 0}" min="0" max="63" style="width:60px" />
        <label>Max Length</label>
        <input type="number" id="ff-len" value="${f?.maxLength ?? 8}" min="1" max="64" style="width:60px" />
      </div>
      <div class="def-form-row"><label>Null-terminated</label>
        <input type="checkbox" id="ff-null"${f?.nullTerminated !== false ? ' checked' : ''} />
      </div>
    `;
  } else {
    const f = existing as BitFieldDefinition | null;
    const bits = f?.bits ?? [];
    defFieldForm.innerHTML = `
      <div class="def-form-row"><label>Name</label>
        <input type="text" id="ff-name" value="${escHtml(f?.name ?? '')}" style="flex:1" />
      </div>
      <div class="def-form-row"><label>Byte Index</label>
        <input type="number" id="ff-byte" value="${f?.byteIndex ?? 0}" min="0" max="7" style="width:60px" />
      </div>
      <div class="field-section-title">BIT SIGNALS</div>
      <div id="def-bit-signals"></div>
      <button id="def-add-bit-signal">+ Add Bit Signal</button>
    `;
    const bitsContainer = defFieldForm.querySelector('#def-bit-signals')!;
    bits.forEach((b, i) => addBitSignalRow(bitsContainer, b, i));
    defFieldForm.querySelector('#def-add-bit-signal')!.addEventListener('click', () => {
      addBitSignalRow(bitsContainer, null, bitsContainer.children.length);
    });
  }
}

function addBitSignalRow(container: Element, signal: BitSignalDefinition | null, _idx: number): void {
  const row = document.createElement('div');
  row.className = 'def-bit-row';
  row.innerHTML = `
    <label>Bit</label>
    <input type="number" class="bs-bit" value="${signal?.bit ?? 0}" min="0" max="7" />
    <label>Name</label>
    <input type="text" class="bs-name" value="${escHtml(signal?.name ?? '')}" />
    <label><input type="checkbox" class="bs-activehigh"${signal?.activeHigh === false ? '' : ' checked'} /> Active High</label>
    <button class="def-bit-row-del">×</button>
  `;
  row.querySelector('.def-bit-row-del')!.addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function readFieldForm(): CanFieldDefinition | null {
  const nameEl = defFieldForm.querySelector('#ff-name') as HTMLInputElement | null;
  const name = nameEl?.value.trim() ?? '';
  if (!name) { showToast('Field name is required'); return null; }

  if (editingFieldKind === 'number') {
    const startByte = parseInt((defFieldForm.querySelector('#ff-start') as HTMLInputElement).value, 10);
    const startBit  = parseInt((defFieldForm.querySelector('#ff-startbit') as HTMLInputElement).value, 10);
    const lenVal    = parseInt((defFieldForm.querySelector('#ff-len') as HTMLInputElement).value, 10);
    const lenUnit   = (defFieldForm.querySelector('#ff-lenunit') as HTMLSelectElement).value;
    const bitLength = lenUnit === 'bytes' ? lenVal * 8 : lenVal;
    const byteOrder = (defFieldForm.querySelector('#ff-order') as HTMLSelectElement).value as ByteOrder;
    const signed    = (defFieldForm.querySelector('#ff-signed') as HTMLInputElement).checked;
    const scale     = parseFloat((defFieldForm.querySelector('#ff-scale') as HTMLInputElement).value);
    const offset    = parseFloat((defFieldForm.querySelector('#ff-offset') as HTMLInputElement).value);
    const base      = (defFieldForm.querySelector('#ff-base') as HTMLSelectElement).value as 'dec' | 'hex';
    const unit      = (defFieldForm.querySelector('#ff-unit') as HTMLInputElement).value.trim();
    const defSb     = byteOrder === 'big' ? 7 : 0;
    const f: NumberFieldDefinition = { kind: 'number', name, startByte, bitLength, byteOrder, signed };
    if (startBit !== defSb) f.startBit = startBit;
    if (scale !== 1)        f.scale    = scale;
    if (offset !== 0)       f.offset   = offset;
    if (base !== 'dec')     f.base     = base;
    if (unit)               f.unit     = unit;
    return f;
  } else if (editingFieldKind === 'string') {
    const startByte     = parseInt((defFieldForm.querySelector('#ff-start') as HTMLInputElement).value, 10);
    const maxLength     = parseInt((defFieldForm.querySelector('#ff-len') as HTMLInputElement).value, 10);
    const nullTerminated = (defFieldForm.querySelector('#ff-null') as HTMLInputElement).checked;
    const f: StringFieldDefinition = { kind: 'string', name, startByte, maxLength };
    if (!nullTerminated) f.nullTerminated = false;
    return f;
  } else {
    const byteIndex = parseInt((defFieldForm.querySelector('#ff-byte') as HTMLInputElement).value, 10);
    const bitRows   = Array.from(defFieldForm.querySelectorAll('.def-bit-row'));
    const bits: BitSignalDefinition[] = bitRows.map((row) => ({
      bit:        parseInt((row.querySelector('.bs-bit') as HTMLInputElement).value, 10),
      name:       (row.querySelector('.bs-name') as HTMLInputElement).value.trim(),
      activeHigh: (row.querySelector('.bs-activehigh') as HTMLInputElement).checked,
    })).filter((b) => b.name);
    return { kind: 'bits', name, byteIndex, bits };
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

refreshPorts();
