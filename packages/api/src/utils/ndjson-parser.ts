/**
 * NDJSON Stream Parser
 * 将 Node.js Readable 流逐行解析为 JSON 对象
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** Sentinel object for JSON parse errors */
export interface ParseError {
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
export async function* parseNDJSON(stream: Readable): AsyncGenerator<unknown> {
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      yield {
        __parseError: true,
        line: trimmed,
        error: 'Failed to parse JSON line',
      } satisfies ParseError as unknown;
    }
  }
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
