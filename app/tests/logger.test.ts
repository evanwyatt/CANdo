import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../src/logger';
import type { CanFrame } from '../src/protocol';

function makeFrame(overrides: Partial<CanFrame> = {}): CanFrame {
  return {
    seq: 0, ts: 0, id: 0x100, ext: false, rtr: false, fd: false, brs: false, dlc: 2,
    data: new Uint8Array([0xAA, 0xBB]),
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
      data: new Uint8Array([0x11, 0x22, 0x33, 0x44])
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
