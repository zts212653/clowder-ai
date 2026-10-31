import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = Buffer.from('\n[managed-runner log truncated; final bytes follow]\n');
const HEAD_BYTES = MAX_LOG_BYTES - TAIL_BYTES - TRUNCATION_MARKER.length;

export function openDurableManagedRunnerLog(logPath: string): {
  readonly capture: (chunk: Buffer) => void;
  readonly finish: () => void;
} {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'w', 0o600);
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let truncated = false;
  let open = true;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  const flushTail = () => {
    if (!open || !truncated) return;
    writeSync(logFd, TRUNCATION_MARKER, 0, TRUNCATION_MARKER.length, headBytes);
    writeSync(logFd, tail, 0, tail.length, headBytes + TRUNCATION_MARKER.length);
    ftruncateSync(logFd, headBytes + TRUNCATION_MARKER.length + tail.length);
  };

  return {
    capture(chunk) {
      if (!open) return;
      let writtenFromChunk = 0;
      if (headBytes < HEAD_BYTES) {
        const headChunk = chunk.subarray(0, Math.min(chunk.length, HEAD_BYTES - headBytes));
        writeSync(logFd, headChunk);
        headBytes += headChunk.length;
        writtenFromChunk = headChunk.length;
      }
      if (writtenFromChunk < chunk.length) truncated = true;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
      if (truncated && !pendingFlush) {
        pendingFlush = setTimeout(() => {
          pendingFlush = null;
          flushTail();
        }, 250);
        pendingFlush.unref();
      }
    },
    finish() {
      if (!open) return;
      if (pendingFlush) clearTimeout(pendingFlush);
      flushTail();
      fsyncSync(logFd);
      closeSync(logFd);
      open = false;
    },
  };
}
