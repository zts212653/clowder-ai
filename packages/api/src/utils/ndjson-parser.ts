/**
 * NDJSON Stream Parser
 * 将 Node.js Readable 流逐行解析为 JSON 对象
 */

import type { Readable } from 'node:stream';

const SKIP_RECORD = Symbol('skip-record');

// Large legitimate tool records remain supported, while a single history dump
// cannot consume the shared API heap. Applies to wire bytes, not JS heap size.
export const DEFAULT_MAX_NDJSON_RECORD_BYTES = 64 * 1024 * 1024;

export class NdjsonRecordTooLargeError extends Error {
  readonly code = 'NDJSON_RECORD_TOO_LARGE';

  constructor(
    readonly recordBytes: number | undefined,
    readonly maxRecordBytes: number,
  ) {
    super(
      `Protocol record exceeds ${maxRecordBytes} bytes${recordBytes === undefined ? '' : ` (observed ${recordBytes})`}; payload omitted`,
    );
    this.name = 'NdjsonRecordTooLargeError';
  }
}

/** Sentinel object for JSON parse errors */
interface ParseError {
  readonly __parseError: true;
  readonly line: string;
  readonly error: string;
}

/**
 * Parse a Readable stream of NDJSON (newline-delimited JSON) into
 * an async iterable of parsed objects.
 *
 * Blank lines are silently skipped.
 * Lines that fail JSON.parse are yielded as ParseError objects.
 */
export async function* parseNDJSON(
  stream: Readable,
  options: { maxRecordBytes?: number } = {},
): AsyncGenerator<unknown> {
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_NDJSON_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new RangeError('maxRecordBytes must be a positive safe integer');
  }
  let fragments: Buffer[] = [];
  let recordBytes = 0;
  let tailBytes = 0;
  const append = (fragment: Buffer): void => {
    recordBytes += fragment.byteLength;
    if (recordBytes > maxRecordBytes) throw new NdjsonRecordTooLargeError(recordBytes, maxRecordBytes);
    // Fixed-size blocks bound allocation overhead even for one-byte chunks,
    // and a small tail cannot retain an entire unrelated input chunk.
    for (let offset = 0; offset < fragment.length; ) {
      let tail = fragments.at(-1);
      if (!tail || tailBytes === tail.length) {
        tail = Buffer.allocUnsafe(Math.min(64 * 1024, maxRecordBytes));
        fragments.push(tail);
        tailBytes = 0;
      }
      const copied = fragment.copy(tail, tailBytes, offset);
      tailBytes += copied;
      offset += copied;
    }
  };

  const parseRecord = (line: string): unknown | typeof SKIP_RECORD => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return SKIP_RECORD;

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return {
        __parseError: true,
        line: trimmed,
        error: 'Failed to parse JSON line',
      } satisfies ParseError as unknown;
    }
  };

  const parsePending = (): unknown | typeof SKIP_RECORD => {
    // Keep fragments as wire bytes outside the JS heap. Decoding only a full
    // record also preserves UTF-8 code points split across incoming chunks.
    const line = Buffer.concat(fragments, recordBytes).toString('utf8');
    fragments = [];
    recordBytes = 0;
    tailBytes = 0;
    return parseRecord(line);
  };

  const finishRecord = (fragment: Buffer): unknown | typeof SKIP_RECORD => {
    // Most protocol records arrive whole; do not allocate a block for them.
    if (recordBytes === 0) {
      if (fragment.length > maxRecordBytes) throw new NdjsonRecordTooLargeError(fragment.length, maxRecordBytes);
      return parseRecord(fragment.toString('utf8'));
    }
    append(fragment);
    return parsePending();
  };

  for await (const chunk of stream) {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk))
      throw new TypeError('NDJSON stream emitted a non-byte chunk');
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    let newlineIndex = bytes.indexOf(0x0a, start);
    while (newlineIndex !== -1) {
      const parsed = finishRecord(bytes.subarray(start, newlineIndex));
      if (parsed !== SKIP_RECORD) yield parsed;
      start = newlineIndex + 1;
      newlineIndex = bytes.indexOf(0x0a, start);
    }
    append(bytes.subarray(start));
  }

  const finalRecord = parsePending();
  if (finalRecord !== SKIP_RECORD) yield finalRecord;
}

/**
 * Type guard for NDJSON parse error objects
 */
export function isParseError(value: unknown): value is ParseError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__parseError' in value &&
    (value as Record<string, unknown>).__parseError === true
  );
}
