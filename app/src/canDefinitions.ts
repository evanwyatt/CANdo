import type { CanFrame } from './protocol';

export type ByteOrder = 'little' | 'big';

export interface CanDefinitionFile {
  version: 1;
  name: string;
  messages: CanMessageDefinition[];
}

export interface CanMessageDefinition {
  name: string;
  id: number;
  mask: number;
  description?: string;
  fields: CanFieldDefinition[];
}

export interface NumberFieldDefinition {
  kind: 'number';
  name: string;
  startByte: number;
  startBit?: number;    // bit within startByte (0=LSB, 7=MSB). LE default: 0. BE default: 7.
  byteLength?: number;  // backward compat; prefer bitLength
  bitLength?: number;   // total bits. Fallback: (byteLength ?? 1) * 8.
  byteOrder: ByteOrder;
  signed?: boolean;
  scale?: number;
  offset?: number;
  base?: 'dec' | 'hex';
  unit?: string;
}

export interface BitSignalDefinition {
  bit: number;
  name: string;
  activeHigh?: boolean;
}

export interface BitFieldDefinition {
  kind: 'bits';
  name: string;
  byteIndex: number;
  bits: BitSignalDefinition[];
}

export interface StringFieldDefinition {
  kind: 'string';
  name: string;
  startByte: number;
  maxLength: number;
  nullTerminated?: boolean;  // default true — stop at first 0x00
}

export type CanFieldDefinition = NumberFieldDefinition | BitFieldDefinition | StringFieldDefinition;

export interface DecodedFieldValue {
  name: string;
  value: string;
  rawValue?: string;
}

export interface DecodedCanMessage {
  definition: CanMessageDefinition;
  values: DecodedFieldValue[];
}

export function findMatchingDefinition(
  frame: Pick<CanFrame, 'id'>,
  definitionFile: CanDefinitionFile | null,
): CanMessageDefinition | null {
  if (!definitionFile) return null;
  return definitionFile.messages.find((message) => {
    return (frame.id & message.mask) === (message.id & message.mask);
  }) ?? null;
}

export function decodeFrameWithDefinitions(
  frame: Pick<CanFrame, 'id' | 'dlc' | 'data'>,
  definitionFile: CanDefinitionFile | null,
): DecodedCanMessage | null {
  const definition = findMatchingDefinition(frame, definitionFile);
  if (!definition) return null;

  return {
    definition,
    values: definition.fields.map((field) => decodeField(frame, field)),
  };
}

function decodeField(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  field: CanFieldDefinition,
): DecodedFieldValue {
  if (field.kind === 'number') return decodeNumberField(frame, field);
  if (field.kind === 'string') return decodeStringField(frame, field);
  return decodeBitField(frame, field);
}

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

function numberFieldEndByte(field: NumberFieldDefinition): number {
  const startBit = field.startBit ?? (field.byteOrder === 'big' ? 7 : 0);
  const bitLen   = field.bitLength ?? ((field.byteLength ?? 1) * 8);
  if (field.byteOrder === 'little') {
    return (field.startByte * 8 + startBit + bitLen - 1) >> 3;
  }
  const rem = Math.max(0, bitLen - (startBit + 1));
  return field.startByte + (rem === 0 ? 0 : Math.ceil(rem / 8));
}

function decodeNumberField(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  field: NumberFieldDefinition,
): DecodedFieldValue {
  const startBit = field.startBit ?? (field.byteOrder === 'big' ? 7 : 0);
  const bitLen   = field.bitLength ?? ((field.byteLength ?? 1) * 8);
  const endByte  = numberFieldEndByte(field);

  if (field.startByte < 0 || bitLen <= 0 || endByte >= frame.dlc) {
    return { name: field.name, value: 'n/a' };
  }

  const rawUnsigned = field.byteOrder === 'little'
    ? extractBitsLE(frame.data, field.startByte, startBit, bitLen)
    : extractBitsBE(frame.data, field.startByte, startBit, bitLen);

  let rawValue = rawUnsigned;
  if (field.signed) rawValue = toSigned(rawUnsigned, bitLen);

  const hexStr  = rawUnsigned.toString(16).toUpperCase().padStart(Math.ceil(bitLen / 4), '0');
  const rawText = field.base === 'hex' ? `0x${hexStr}` : rawValue.toString();

  if ((field.scale ?? 1) !== 1 || (field.offset ?? 0) !== 0) {
    const numericValue = bigIntToNumber(rawValue);
    if (numericValue === null) {
      return { name: field.name, value: rawText + (field.unit ? ` ${field.unit}` : ''), rawValue: rawText };
    }
    return {
      name: field.name,
      value: formatScaledValue(numericValue * (field.scale ?? 1) + (field.offset ?? 0), field.unit),
      rawValue: rawText,
    };
  }

  return {
    name: field.name,
    value: rawText + (field.unit ? ` ${field.unit}` : ''),
    rawValue: rawText,
  };
}

function decodeBitField(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  field: BitFieldDefinition,
): DecodedFieldValue {
  if (field.byteIndex < 0 || field.byteIndex >= frame.dlc) {
    return { name: field.name, value: 'n/a' };
  }

  const value = frame.data[field.byteIndex];
  const parts = field.bits
    .slice()
    .sort((left, right) => left.bit - right.bit)
    .map((bit) => {
      const set = ((value >> bit.bit) & 0x01) === 0x01;
      const interpreted = bit.activeHigh === false ? !set : set;
      return `${bit.name}=${interpreted ? 1 : 0}`;
    });

  return {
    name: field.name,
    value: parts.join(', '),
    rawValue: `0x${value.toString(16).toUpperCase().padStart(2, '0')}`,
  };
}

function decodeStringField(
  frame: Pick<CanFrame, 'dlc' | 'data'>,
  field: StringFieldDefinition,
): DecodedFieldValue {
  if (field.startByte >= frame.dlc) return { name: field.name, value: 'n/a' };
  const maxBytes = Math.min(field.maxLength, frame.dlc - field.startByte);
  const bytes = Array.from(frame.data.slice(field.startByte, field.startByte + maxBytes));
  const nullIdx = field.nullTerminated !== false ? bytes.indexOf(0) : -1;
  const chars   = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes;
  const str = chars
    .map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)
    .join('');
  return { name: field.name, value: `"${str}"` };
}

function toSigned(value: bigint, bitCount: number): bigint {
  const signBit = 1n << BigInt(bitCount - 1);
  if ((value & signBit) === 0n) return value;
  return value - (1n << BigInt(bitCount));
}

function bigIntToNumber(value: bigint): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function formatScaledValue(value: number, unit?: string): string {
  const text = Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return unit ? `${text} ${unit}` : text;
}
