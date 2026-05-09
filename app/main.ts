import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { SerialPort } from 'serialport';
import { SerialManager } from './src/serial';
import { Logger } from './src/logger';
import type { AppStatus, SpeedIndex, CapabilityInfo } from './src/protocol';
import { parseTransmitData } from './src/transmit';
import { decodeFrameWithDefinitions } from './src/canDefinitions';
import type { CanDefinitionFile } from './src/canDefinitions';


let win:    BrowserWindow | null = null;
let serial: SerialManager        = new SerialManager();
let logger: Logger               = new Logger();
let repeatTimer: ReturnType<typeof setInterval> | null = null;
let activeDefinitions: CanDefinitionFile | null = null;

let status: AppStatus = {
  connected:    false,
  channelOpen:  false,
  recording:    false,
  recordPath:   null,
  errorCount:   0,
  repeatActive: false,
};

function pushStatus(): void {
  win?.webContents.send('status', { ...status });
}

function stopRepeatTimer(): void {
  if (repeatTimer) {
    clearInterval(repeatTimer);
    repeatTimer = null;
  }
  if (status.repeatActive) {
    status.repeatActive = false;
    pushStatus();
  }
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
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
    const decoded = decodeFrameWithDefinitions(frame, activeDefinitions);
    const decodedPayload = decoded
      ? { msgName: decoded.definition.name, values: decoded.values }
      : null;
    win?.webContents.send('frame', { frame, decoded: decodedPayload });
  });

  serial.on('caps', (caps: CapabilityInfo) => {
    win?.webContents.send('caps', caps);
  });

  serial.on('close', () => {
    stopRepeatTimer();
    status.connected   = false;
    status.channelOpen = false;
    if (status.recording) {
      logger.stopLogging();
      status.recording  = false;
      status.recordPath = null;
    }
    pushStatus();
  });

  serial.on('error', (err: Error) => {
    win?.webContents.send('toast', `Serial error: ${err.message}`);
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

// ── IPC handlers ──────────────────────────────────────────────────────────────

// CANdo USB identity — must match firmware build flags USBD_VID / USBD_PID_FS.
// Set to null to disable filtering and show all serial ports.
const CANDO_VID = '1209';
const CANDO_PID = 'cad0';

ipcMain.handle('listPorts', async () => {
  const ports = await SerialPort.list();
  return ports.map((p) => {
    const friendly = (p as unknown as Record<string, string>)['friendlyName'];
    const isTarget = CANDO_VID !== null
      && p.vendorId?.toLowerCase() === CANDO_VID
      && p.productId?.toLowerCase() === CANDO_PID;
    return {
      path:         p.path,
      manufacturer: p.manufacturer,
      friendlyName: friendly,
      isTarget,
    };
  });
});

ipcMain.handle('connect', async (_e, portPath: string) => {
  await serial.open(portPath);
  try {
    await serial.sendHello();
  } catch (err) {
    await serial.close();
    throw err;
  }
  status.connected = true;
  pushStatus();
});

ipcMain.handle('disconnect', async () => {
  stopRepeatTimer();
  if (status.channelOpen) {
    try { await serial.sendClose(); } catch (_) {}
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
  return await serial.sendSetSpeed(index - 1);
});

ipcMain.handle('openChannel', async () => {
  const result = await serial.sendOpen();
  if (result === 'OK') {
    serial.markChannelOpen();
    status.channelOpen = true;
    pushStatus();
  }
  return result;
});

ipcMain.handle('closeChannel', async () => {
  stopRepeatTimer();
  const result = await serial.sendClose();
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

// ── Transmit ──────────────────────────────────────────────────────────────────

ipcMain.handle('transmitFrame', (_e, req: {
  id: number; ext: boolean; rtr: boolean; fd: boolean; brs: boolean; dlc: number; dataHex: string;
}) => {
  const data  = parseTransmitData(req.dataHex);
  const flags = (req.ext ? 0x01 : 0) | (req.rtr ? 0x02 : 0) | (req.fd ? 0x04 : 0) | (req.brs ? 0x08 : 0);
  serial.transmit(req.id, flags, req.dlc, data);
});

ipcMain.handle('startRepeat', (_e, req: {
  id: number; ext: boolean; rtr: boolean; fd: boolean; brs: boolean; dlc: number; dataHex: string;
}, intervalMs: number, count: number) => {
  stopRepeatTimer();
  const data  = parseTransmitData(req.dataHex);
  const flags = (req.ext ? 0x01 : 0) | (req.rtr ? 0x02 : 0) | (req.fd ? 0x04 : 0) | (req.brs ? 0x08 : 0);
  const limit = count > 0 ? count : Infinity;
  let sent = 1;
  serial.transmit(req.id, flags, req.dlc, data);
  if (sent >= limit) return;
  repeatTimer = setInterval(() => {
    serial.transmit(req.id, flags, req.dlc, data);
    sent++;
    if (sent >= limit) stopRepeatTimer();
  }, Math.max(1, intervalMs));
  status.repeatActive = true;
  pushStatus();
});

ipcMain.handle('stopRepeat', () => {
  stopRepeatTimer();
});

// ── Definitions ───────────────────────────────────────────────────────────────

ipcMain.handle('loadDefinitions', async () => {
  const result = await dialog.showOpenDialog(win!, {
    filters:    [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) throw new Error('Cancelled');
  const raw  = fs.readFileSync(result.filePaths[0], 'utf-8');
  const defs = JSON.parse(raw) as CanDefinitionFile;
  activeDefinitions = defs;
  win?.webContents.send('definitions', activeDefinitions);
  return defs;
});

ipcMain.handle('saveDefinitions', async (_e, defs: CanDefinitionFile) => {
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: `${defs.name || 'definitions'}.json`,
    filters:     [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) throw new Error('Cancelled');
  fs.writeFileSync(result.filePath, JSON.stringify(defs, null, 2), 'utf-8');
  activeDefinitions = defs;
  win?.webContents.send('definitions', activeDefinitions);
  return result.filePath;
});

ipcMain.handle('setDefinitions', (_e, defs: CanDefinitionFile | null) => {
  activeDefinitions = defs;
  win?.webContents.send('definitions', activeDefinitions);
});
