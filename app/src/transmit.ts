import { dlcToBytes } from './protocol';

export interface CanTransmitRequest {
  id:  number;
  ext: boolean;
  rtr: boolean;
  dlc: number;
  data: Uint8Array;
}

export function parseTransmitData(text: string): Uint8Array {
  const compact = text.replace(/[^0-9a-fA-F]/g, '');
  if (compact.length === 0) return new Uint8Array(0);
  if (compact.length % 2 !== 0) throw new Error('Data must contain whole bytes in hex form');

  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(parseInt(compact.slice(index, index + 2), 16));
  }
  return Uint8Array.from(bytes);
}

export function validateTransmitRequest(request: CanTransmitRequest): void {
  const maxId = request.ext ? 0x1FFFFFFF : 0x7FF;
  if (request.id < 0 || request.id > maxId) {
    throw new Error(
      request.ext
        ? 'Extended CAN ID must be between 0x0 and 0x1FFFFFFF'
        : 'Standard CAN ID must be between 0x0 and 0x7FF',
    );
  }
  if (request.dlc < 0 || request.dlc > 15) {
    throw new Error('DLC must be between 0 and 15');
  }
  const required = dlcToBytes(request.dlc);
  if (!request.rtr && request.data.length < required) {
    throw new Error(`DLC ${request.dlc} requires ${required} bytes but only ${request.data.length} provided`);
  }
  if (request.rtr && request.data.length !== 0) {
    throw new Error('RTR frames cannot include data bytes');
  }
}
