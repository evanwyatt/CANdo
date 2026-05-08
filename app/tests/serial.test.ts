// Tests exercise parseBuffer integration through SerialManager._handleData.
// SerialPort itself is not opened — we call internal methods directly.
import { SerialManager } from '../src/serial';
import { cobsEncode, CMD_SET_SPEED, PKT_CAN_FRAME } from '../src/protocol';

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

    // Build packet: [PKT_CAN_FRAME] + frame payload, COBS + 0x00
    const payload = Buffer.alloc(9); // type(1) + id(4) + flags(1) + dlc(1) + 2 data
    payload[0] = PKT_CAN_FRAME;
    payload.writeUInt32LE(0x100, 1);
    payload[5] = 0x00;
    payload[6] = 2;
    payload.set([0xAA, 0xBB], 7);
    const packet = Buffer.concat([cobsEncode(payload), Buffer.from([0x00])]);

    (mgr as any)._handleData(packet);
  });

  it('resolves pending command on OK response', (done) => {
    const p = (mgr as any)._enqueueCommand(Buffer.from([CMD_SET_SPEED, 0]));
    p.then((result: string) => {
      expect(result).toBe('OK');
      done();
    });
    // PKT_RESPONSE(0x02) + status(0x00=OK), COBS encoded
    const ok = Buffer.concat([cobsEncode(Buffer.from([0x02, 0x00])), Buffer.from([0x00])]);
    (mgr as any)._handleData(ok);
  });

  it('rejects pending command on KO response', (done) => {
    const p = (mgr as any)._enqueueCommand(Buffer.from([CMD_SET_SPEED, 0]));
    p.catch((err: Error) => {
      expect(err.message).toBe('KO');
      done();
    });
    // PKT_RESPONSE(0x02) + status(0xFF=KO), COBS encoded
    const ko = Buffer.concat([cobsEncode(Buffer.from([0x02, 0xFF])), Buffer.from([0x00])]);
    (mgr as any)._handleData(ko);
  });

  it('accumulates partial data across multiple calls', (done) => {
    mgr.on('frame', (frame) => {
      expect(frame.id).toBe(0x200);
      done();
    });

    const payload = Buffer.alloc(8); // type(1) + id(4) + flags(1) + dlc(1) + 1 data
    payload[0] = PKT_CAN_FRAME;
    payload.writeUInt32LE(0x200, 1);
    payload[5] = 0x00;
    payload[6] = 1;
    payload[7] = 0xFF;
    const packet = Buffer.concat([cobsEncode(payload), Buffer.from([0x00])]);

    // Split packet and deliver in two separate calls
    (mgr as any)._handleData(packet.slice(0, 5));
    (mgr as any)._handleData(packet.slice(5));
  });
});
