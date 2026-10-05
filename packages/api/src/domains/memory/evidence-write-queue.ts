/**
 * F163: Single-writer scheduler for ALL evidence.sqlite mutations.
 * Design Gate contract 3 — serializes SqliteEvidenceStore writes + IndexBuilder direct writes.
 */

import { setImmediate as yieldToIo } from 'node:timers/promises';

export class EvidenceWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Enqueue a write operation. Returns its result when executed. FIFO, no interleaving. */
  enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tail = this.tail.then(async () => {
        try {
          await yieldToIo();
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
