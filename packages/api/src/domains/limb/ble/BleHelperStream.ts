import { Buffer } from 'node:buffer';
import { BLE_HELPER_MAX_LINE_BYTES, type BleHelperInboundMessage, parseBleHelperMessage } from './BleHelperProtocol.js';

export interface BleHelperFrame {
  rest: string;
  lines: string[];
  oversizedRest: boolean;
}

export type BleHelperParseResult = { ok: true; message: BleHelperInboundMessage } | { ok: false; error: Error };

export function frameBleHelperChunk(previous: string, chunk: string): BleHelperFrame {
  const parts = `${previous}${chunk}`.split('\n');
  const rest = parts.pop() ?? '';
  return {
    rest,
    lines: parts.map((line) => line.replace(/\r$/, '')).filter(Boolean),
    oversizedRest: Buffer.byteLength(rest, 'utf8') > BLE_HELPER_MAX_LINE_BYTES,
  };
}

export function tryParseBleHelperMessage(line: string): BleHelperParseResult {
  try {
    return { ok: true, message: parseBleHelperMessage(line) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
