import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import {
  parseBuffer, cobsEncode, dlcToBytes,
  CMD_SET_SPEED, CMD_OPEN, CMD_CLOSE, CMD_TRANSMIT, CMD_HELLO,
  CanFrame, CapabilityInfo,
} from './protocol';

const COMMAND_TIMEOUT_MS = 2000;

interface PendingCommand {
  resolve: (value: string) => void;
  reject:  (err: Error)   => void;
  timer:   ReturnType<typeof setTimeout>;
}

export class SerialManager extends EventEmitter {
  private port:   SerialPort | null = null;
  private buf:    Buffer = Buffer.alloc(0);
  private queue:  PendingCommand[] = [];
  private seq:    number = 0;
  private openTs: number = 0;

  async open(path: string): Promise<void> {
    if (this.port) throw new Error('Already open — call close() first');
    return new Promise((resolve, reject) => {
      const p = new SerialPort({ path, baudRate: 115200, autoOpen: false });
      p.open((err) => {
        if (err) return reject(err);
        this.port = p;
        this._resetState();
        p.on('data',  (chunk: Buffer) => this._handleData(chunk));
        p.on('error', (err: Error) => {
          this._flushQueue(err);
          this.emit('error', err);
        });
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
      this.port.close((err) => {
        if (err) this.emit('error', err);
        this._resetState();
        resolve();
      });
    });
  }

  sendHello(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onHello = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.removeListener('hello', onHello);
        reject(new Error('Device did not respond to hello — wrong firmware?'));
      }, COMMAND_TIMEOUT_MS);
      this.once('hello', onHello);
      this._writePacket(Buffer.from([CMD_HELLO]));
    });
  }

  sendSetSpeed(index: number): Promise<string> {
    return this._enqueueCommand(Buffer.from([CMD_SET_SPEED, index]));
  }

  sendOpen(): Promise<string> {
    return this._enqueueCommand(Buffer.from([CMD_OPEN]));
  }

  sendClose(): Promise<string> {
    return this._enqueueCommand(Buffer.from([CMD_CLOSE]));
  }

  transmit(id: number, flags: number, dlc: number, data: Uint8Array): void {
    const byteCount = dlcToBytes(dlc);
    const payload = Buffer.alloc(7 + byteCount);
    payload[0] = CMD_TRANSMIT;
    payload.writeUInt32LE(id, 1);
    payload[5] = flags;
    payload[6] = dlc;
    payload.set(data.slice(0, byteCount), 7);
    this._writePacket(payload);
  }

  markChannelOpen(): void  { this.openTs = Date.now(); }
  markChannelClosed(): void { this.openTs = 0; }

  // Exposed for testing
  _handleData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const ts = this.openTs ? Date.now() - this.openTs : 0;

    this.buf = parseBuffer(
      this.buf,
      this.seq,
      ts,
      (frame: CanFrame) => {
        this.seq++;
        this.emit('frame', frame);
      },
      (ok: boolean) => {
        const pending = this.queue.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        if (ok) pending.resolve('OK');
        else pending.reject(new Error('KO'));
      },
      () => { this.emit('hello'); },
      (caps: CapabilityInfo) => { this.emit('caps', caps); },
    );
  }

  // Exposed for testing — payload is the raw pre-COBS packet (type byte + data)
  _enqueueCommand(payload: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((p) => p.timer === timer);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error('Command timeout'));
      }, COMMAND_TIMEOUT_MS);

      this.queue.push({ resolve, reject, timer });
      this._writePacket(payload);
    });
  }

  private _writePacket(payload: Buffer): void {
    if (!this.port) return;
    const encoded = cobsEncode(payload);
    const packet  = Buffer.concat([encoded, Buffer.from([0x00])]);
    this.port.write(packet);
  }

  private _resetState(): void {
    this.buf    = Buffer.alloc(0);
    this.seq    = 0;
    this.openTs = 0;
  }

  private _flushQueue(err: Error): void {
    for (const p of this.queue) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.queue = [];
  }
}
