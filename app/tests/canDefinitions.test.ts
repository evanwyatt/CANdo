import { decodeFrameWithDefinitions, findMatchingDefinition, type CanDefinitionFile } from '../src/canDefinitions';

const definitionFile: CanDefinitionFile = {
  version: 1,
  name: 'Powertrain',
  messages: [
    {
      name: 'MotorStatus',
      id: 0x180,
      mask: 0x7F0,
      fields: [
        {
          kind: 'number',
          name: 'rpm',
          startByte: 0,
          byteLength: 2,
          byteOrder: 'little',
          signed: false,
        },
        {
          kind: 'number',
          name: 'voltage',
          startByte: 2,
          byteLength: 2,
          byteOrder: 'big',
          signed: false,
          scale: 0.1,
          unit: 'V',
        },
        {
          kind: 'bits',
          name: 'flags',
          byteIndex: 4,
          bits: [
            { bit: 0, name: 'ready' },
            { bit: 3, name: 'fault' },
          ],
        },
      ],
    },
  ],
};

describe('findMatchingDefinition', () => {
  it('matches a frame by id and mask', () => {
    const match = findMatchingDefinition({ id: 0x18A }, definitionFile);
    expect(match?.name).toBe('MotorStatus');
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingDefinition({ id: 0x220 }, definitionFile)).toBeNull();
  });
});

describe('decodeFrameWithDefinitions', () => {
  it('decodes numeric and bit fields', () => {
    const frame = {
      id: 0x18A,
      dlc: 5,
      data: Uint8Array.from([0x34, 0x12, 0x01, 0xF4, 0x09, 0x00, 0x00, 0x00]),
    };

    const decoded = decodeFrameWithDefinitions(frame, definitionFile);
    expect(decoded?.definition.name).toBe('MotorStatus');
    expect(decoded?.values).toEqual([
      { name: 'rpm', value: '4660', rawValue: '4660' },
      { name: 'voltage', value: '50 V', rawValue: '500' },
      { name: 'flags', value: 'ready=1, fault=1', rawValue: '0x09' },
    ]);
  });

  it('returns n/a for fields outside the frame dlc', () => {
    const frame = {
      id: 0x180,
      dlc: 1,
      data: Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    };

    const decoded = decodeFrameWithDefinitions(frame, definitionFile);
    expect(decoded?.values[0]).toEqual({ name: 'rpm', value: 'n/a' });
    expect(decoded?.values[1]).toEqual({ name: 'voltage', value: 'n/a' });
    expect(decoded?.values[2]).toEqual({ name: 'flags', value: 'n/a' });
  });
});
