import { parseTransmitData, validateTransmitRequest } from '../src/transmit';

describe('parseTransmitData', () => {
  it('parses compact or spaced hex bytes', () => {
    expect(Array.from(parseTransmitData('01 02 aa FF'))).toEqual([0x01, 0x02, 0xAA, 0xFF]);
    expect(Array.from(parseTransmitData('0102AAFF'))).toEqual([0x01, 0x02, 0xAA, 0xFF]);
  });

  it('rejects half bytes', () => {
    expect(() => parseTransmitData('ABC')).toThrow('Data must contain whole bytes in hex form');
  });

  it('returns empty array for empty input', () => {
    expect(parseTransmitData('').length).toBe(0);
  });
});

describe('validateTransmitRequest', () => {
  it('accepts a standard frame with valid id and data', () => {
    expect(() => validateTransmitRequest({
      id: 0x7FF, ext: false, rtr: false, dlc: 2,
      data: Uint8Array.from([0x01, 0x02]),
    })).not.toThrow();
  });

  it('rejects standard id > 0x7FF', () => {
    expect(() => validateTransmitRequest({
      id: 0x800, ext: false, rtr: false, dlc: 0,
      data: new Uint8Array(0),
    })).toThrow('Standard CAN ID');
  });

  it('accepts extended id up to 0x1FFFFFFF', () => {
    expect(() => validateTransmitRequest({
      id: 0x1FFFFFFF, ext: true, rtr: false, dlc: 0,
      data: new Uint8Array(0),
    })).not.toThrow();
  });

  it('rejects extended id > 0x1FFFFFFF', () => {
    expect(() => validateTransmitRequest({
      id: 0x20000000, ext: true, rtr: false, dlc: 0,
      data: new Uint8Array(0),
    })).toThrow('Extended CAN ID');
  });

  it('accepts CANFD DLC values 9-15', () => {
    expect(() => validateTransmitRequest({
      id: 0x1, ext: false, rtr: false, dlc: 15,
      data: new Uint8Array(64),
    })).not.toThrow();
  });

  it('rejects DLC > 15', () => {
    expect(() => validateTransmitRequest({
      id: 0x1, ext: false, rtr: false, dlc: 16,
      data: new Uint8Array(0),
    })).toThrow('DLC must be between 0 and 15');
  });

  it('rejects RTR frames with data', () => {
    expect(() => validateTransmitRequest({
      id: 0x1, ext: false, rtr: true, dlc: 0,
      data: Uint8Array.from([0x01]),
    })).toThrow('RTR frames cannot include data bytes');
  });

  it('rejects insufficient data bytes for DLC', () => {
    expect(() => validateTransmitRequest({
      id: 0x1, ext: false, rtr: false, dlc: 4,
      data: Uint8Array.from([0x01, 0x02]), // only 2 bytes, need 4
    })).toThrow('DLC 4 requires 4 bytes');
  });
});
