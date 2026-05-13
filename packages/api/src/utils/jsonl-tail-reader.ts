/**
 * Reverse-tail JSONL reader.
 *
 * Reads a JSONL file from EOF backward, parsing entries one at a time
 * (most-recent first), and returns the first entry that matches `predicate`.
 *
 * Designed for the Gemini per-turn token lookup: the local Gemini CLI
 * session jsonl can grow to multi-megabyte sizes, but we only ever need
 * the latest matching message. Loading the whole file with
 * `readFileSync + split('\n')` on every model turn would block the Node.js
 * event loop. This helper opens an fd, reads small chunks from the tail,
 * and stops as soon as a match is found OR a budget is exhausted.
 *
 * Edge cases handled:
 * - empty file → undefined
 * - missing / unreadable file → undefined (no throw)
 * - last line written partially (CLI mid-write race) → unparseable, skipped
 * - non-matching lines (user / `$set` / wrong type) → predicate filter
 * - chunk boundary mid-line → buffered across chunk reads
 * - budget exhausted before match → undefined (caller's fallback path)
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

const DEFAULT_CHUNK_SIZE = 8192;
const DEFAULT_MAX_LINES = 10_000;
const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
/** Cap leading-buffer growth so a pathological multi-MB single line cannot exhaust memory. */
const LEADING_BUFFER_CAP = 1_048_576;

export interface ReadJsonlTailOptions {
  /** Max lines to scan from EOF backward before giving up. Default: 10_000. */
  readonly maxLines?: number;
  /** Max bytes to read from EOF before giving up. Default: 1_048_576 (1 MiB). */
  readonly maxBytes?: number;
  /** Returns true if the parsed JSON entry is the one we want. */
  readonly predicate: (parsed: unknown) => boolean;
}

/**
 * Read a JSONL file from EOF backward and return the latest entry whose
 * parsed JSON matches `predicate`. Returns `undefined` when no match is
 * found within the budget or when the file is unreadable / empty.
 */
export function readJsonlTail<T = unknown>(filePath: string, opts: ReadJsonlTailOptions): T | undefined {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let fd: number;
  let size: number;
  try {
    fd = openSync(filePath, 'r');
    size = statSync(filePath).size;
  } catch {
    return undefined;
  }

  try {
    if (size === 0) return undefined;

    const buffer = Buffer.alloc(DEFAULT_CHUNK_SIZE);
    let position = size;
    let bytesRead = 0;
    let linesScanned = 0;
    // Partial leading from the previous (newer) chunk's first segment. Kept
    // as raw bytes so multi-byte UTF-8 sequences that span a chunk boundary
    // (CJK content is 3 bytes/char and easily crosses an 8 KiB cut) decode
    // correctly when the full line is finally assembled. Decoding per-chunk
    // would insert U+FFFD replacement chars and silently corrupt content,
    // breaking strict-equality predicates.
    let leadingBuffer: Buffer = Buffer.alloc(0);

    while (position > 0) {
      const chunkSize = Math.min(DEFAULT_CHUNK_SIZE, position);
      position -= chunkSize;
      bytesRead += chunkSize;

      const n = readSync(fd, buffer, 0, chunkSize, position);
      if (n === 0) break;

      // Older bytes (this chunk) + newer bytes (leadingBuffer from previous
      // iteration). Together they form a contiguous file slice
      // [position, position + chunkSize + |leadingBuffer|).
      const combined = Buffer.concat([buffer.subarray(0, n), leadingBuffer]);

      // Split on newline byte (0x0a). subarray() returns Buffer views sharing
      // memory with `combined`, so no extra allocation per segment.
      const parts: Buffer[] = [];
      let segmentStart = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === 0x0a) {
          parts.push(combined.subarray(segmentStart, i));
          segmentStart = i + 1;
        }
      }
      parts.push(combined.subarray(segmentStart));

      // When position > 0 we cannot trust parts[0] is a complete line — it may
      // be the back half of a line whose front half lives in the next (older)
      // chunk. Copy its bytes into leadingBuffer for the next iteration (copy
      // is required because the next readSync will overwrite `buffer`, and
      // `combined`/parts views into it).
      // When position === 0 there is no more chunk; parts[0] is the file's
      // first line (complete) and must be processed.
      let processFromIndex: number;
      if (position === 0) {
        processFromIndex = 0;
        leadingBuffer = Buffer.alloc(0);
      } else {
        processFromIndex = 1;
        leadingBuffer = Buffer.from(parts[0] ?? Buffer.alloc(0));
        if (leadingBuffer.length > LEADING_BUFFER_CAP) return undefined;
      }

      // Process complete lines in REVERSE (newest first). Skip empty (trailing
      // newline at EOF) and unparseable (partial-write race) lines.
      for (let i = parts.length - 1; i >= processFromIndex; i--) {
        const lineBytes = parts[i];
        if (lineBytes.length === 0) continue;
        linesScanned++;
        if (linesScanned > maxLines) return undefined;
        let parsed: unknown;
        try {
          // Single utf8 decode of a complete line. Multi-byte sequences are
          // intact because we collected ALL bytes between newlines before
          // decoding (vs the previous per-chunk decode which split mid-char).
          parsed = JSON.parse(lineBytes.toString('utf8'));
        } catch {
          continue;
        }
        if (opts.predicate(parsed)) {
          return parsed as T;
        }
      }

      if (bytesRead >= maxBytes) return undefined;
    }

    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}
