import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { CanFrame } from './protocol';

export class Logger extends EventEmitter {
  private stream: fs.WriteStream | null = null;

  startLogging(filePath: string): void {
    this.stopLogging(); // close any existing stream before opening a new one
    const s = fs.createWriteStream(filePath, { flags: 'w' });
    s.on('error', (err) => {
      this.stream = null;
      this.emit('error', err);
    });
    // Write header before assigning to this.stream so appendFrame can't race
    s.write('seq,ts_ms,id_hex,ext,rtr,dlc,data_hex\n');
    this.stream = s;
  }

  appendFrame(frame: CanFrame): void {
    if (!this.stream) return;
    const idHex   = frame.id.toString(16).toUpperCase().padStart(8, '0');
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
