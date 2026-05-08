import { contextBridge, ipcRenderer } from 'electron';
import type { CanFrame, AppStatus } from './src/protocol';
import type { CanDefinitionFile } from './src/canDefinitions';

export interface DecodedPayload {
  msgName: string;
  values: Array<{ name: string; value: string; rawValue?: string }>;
}

export interface FrameEvent {
  frame:   CanFrame;
  decoded: DecodedPayload | null;
}

export interface TransmitIpcRequest {
  id:      number;
  ext:     boolean;
  rtr:     boolean;
  dlc:     number;
  dataHex: string;
}

contextBridge.exposeInMainWorld('api', {
  // Connection
  listPorts:    () => ipcRenderer.invoke('listPorts'),
  connect:      (path: string) => ipcRenderer.invoke('connect', path),
  disconnect:   () => ipcRenderer.invoke('disconnect'),
  setSpeed:     (index: number) => ipcRenderer.invoke('setSpeed', index),
  openChannel:  () => ipcRenderer.invoke('openChannel'),
  closeChannel: () => ipcRenderer.invoke('closeChannel'),
  startLogging: () => ipcRenderer.invoke('startLogging'),
  stopLogging:  () => ipcRenderer.invoke('stopLogging'),

  // Transmit
  transmitFrame: (req: TransmitIpcRequest) => ipcRenderer.invoke('transmitFrame', req),
  startRepeat:   (req: TransmitIpcRequest, intervalMs: number, count: number) => ipcRenderer.invoke('startRepeat', req, intervalMs, count),
  stopRepeat:    () => ipcRenderer.invoke('stopRepeat'),

  // Definitions
  loadDefinitions:  () => ipcRenderer.invoke('loadDefinitions'),
  saveDefinitions:  (defs: CanDefinitionFile) => ipcRenderer.invoke('saveDefinitions', defs),
  setDefinitions:   (defs: CanDefinitionFile | null) => ipcRenderer.invoke('setDefinitions', defs),

  // Events
  onFrame:       (cb: (ev: FrameEvent) => void) =>
    ipcRenderer.on('frame', (_e, ev) => cb(ev)),
  onStatus:      (cb: (s: AppStatus) => void) =>
    ipcRenderer.on('status', (_e, s) => cb(s)),
  onToast:       (cb: (msg: string) => void) =>
    ipcRenderer.on('toast', (_e, m) => cb(m)),
  onDefinitions: (cb: (defs: CanDefinitionFile | null) => void) =>
    ipcRenderer.on('definitions', (_e, d) => cb(d)),
});
