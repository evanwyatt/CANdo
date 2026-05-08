import { cobsEncode, cobsDecode, unpackFrame, parseBuffer, PKT_CAN_FRAME } from '../src/protocol';

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
    // Wire format (after type byte): [4B id LE][1B flags][1B dlc][N bytes data]
    // id=0x02FF, flags=0x00 (standard, no RTR), dlc=8, 8 bytes data
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
    expect(frame!.fd).toBe(false);
    expect(frame!.brs).toBe(false);
    expect(frame!.dlc).toBe(8);
    expect(Array.from(frame!.data)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  });

  it('unpacks an extended frame (EXT flag bit 0)', () => {
    const buf = Buffer.alloc(9); // 6 header + 3 data bytes
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
    const buf = Buffer.alloc(6); // 6 header, no data
    buf.writeUInt32LE(0x02FF, 0);
    buf[4] = 0x02; // rtr flag
    buf[5] = 0;

    const frame = unpackFrame(buf, 0, 0);
    expect(frame!.rtr).toBe(true);
    expect(frame!.dlc).toBe(0);
  });

  it('unpacks an FD frame (FD flag bit 2)', () => {
    const buf = Buffer.alloc(6 + 12); // 6 header + 12 bytes data (DLC=9)
    buf.writeUInt32LE(0x123, 0);
    buf[4] = 0x04; // fd flag
    buf[5] = 9;

    const frame = unpackFrame(buf, 0, 0);
    expect(frame!.fd).toBe(true);
    expect(frame!.dlc).toBe(9);
    expect(frame!.data.length).toBe(12);
  });

  it('returns null for a buffer shorter than 6 bytes', () => {
    expect(unpackFrame(Buffer.alloc(5), 0, 0)).toBeNull();
  });
});

describe('parseBuffer', () => {
  it('extracts a complete CAN frame from the accumulation buffer', () => {
    // Packet = [PKT_CAN_FRAME=0x01] + frame payload, COBS encoded + 0x00
    const payload = Buffer.alloc(9); // type(1) + id(4) + flags(1) + dlc(1) + 2 data
    payload[0] = PKT_CAN_FRAME;
    payload.writeUInt32LE(0x100, 1);
    payload[5] = 0x00; // flags
    payload[6] = 2;    // dlc
    payload.set([0xAA, 0xBB], 7);

    const frames: ReturnType<typeof unpackFrame>[] = [];
    const responses: boolean[] = [];

    const encoded = cobsEncode(payload);
    const buf = Buffer.concat([encoded, Buffer.from([0x00])]);

    parseBuffer(buf, 0, 0, (f) => frames.push(f), (ok) => responses.push(ok));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(0x100);
    expect(responses).toHaveLength(0);
  });

  it('extracts a binary OK response', () => {
    // PKT_RESPONSE(0x02) + status(0x00=OK), COBS encoded + 0x00
    // Encode [0x02, 0x00]: COBS = [0x02, 0x02, 0x01], packet = [..., 0x00]
    const payload = Buffer.from([0x02, 0x00]);
    const encoded = cobsEncode(payload);
    const buf = Buffer.concat([encoded, Buffer.from([0x00])]);

    const frames: ReturnType<typeof unpackFrame>[] = [];
    const responses: boolean[] = [];
    parseBuffer(buf, 0, 0, (f) => frames.push(f), (ok) => responses.push(ok));
    expect(responses).toEqual([true]);
    expect(frames).toHaveLength(0);
  });

  it('extracts a binary KO response', () => {
    // PKT_RESPONSE(0x02) + status(0xFF=KO)
    const payload = Buffer.from([0x02, 0xFF]);
    const encoded = cobsEncode(payload);
    const buf = Buffer.concat([encoded, Buffer.from([0x00])]);

    const frames: ReturnType<typeof unpackFrame>[] = [];
    const responses: boolean[] = [];
    parseBuffer(buf, 0, 0, (f) => frames.push(f), (ok) => responses.push(ok));
    expect(responses).toEqual([false]);
  });

  it('handles partial frames without emitting', () => {
    const frames: ReturnType<typeof unpackFrame>[] = [];
    const buf = Buffer.from([0x04, 0x11, 0x22]); // no 0x00 terminator yet
    parseBuffer(buf, 0, 0, (f) => frames.push(f), () => {});
    expect(frames).toHaveLength(0);
  });
});
