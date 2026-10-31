/**
 * F258 Visible Café — Render Log (ring buffer)
 *
 * Defense Line 4 L1: render claim log.
 * Records every posture change with source reference for provenance tracing.
 * Ring buffer — 512 entries, append-only, capacity truncation = full lifecycle.
 *
 * INV-4: every non-unknown posture can back-reference its source event id.
 */

export interface RenderLogEntry {
  ts: number;
  catId: string;
  posture: string;
  sourceRef: string | null;
  state: string;
}

const RING_CAPACITY = 512;

export class RenderLog {
  private buffer: RenderLogEntry[] = [];
  private head = 0;
  private count = 0;

  /** Append a new entry. O(1). */
  append(entry: RenderLogEntry): void {
    if (this.count < RING_CAPACITY) {
      this.buffer.push(entry);
      this.count++;
    } else {
      this.buffer[this.head] = entry;
    }
    this.head = (this.head + 1) % RING_CAPACITY;
  }

  /** Get entries in chronological order (oldest first). */
  entries(): RenderLogEntry[] {
    if (this.count < RING_CAPACITY) {
      return [...this.buffer];
    }
    // Ring is full — read from head (oldest) to head-1 (newest)
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  /** Get the N most recent entries. */
  recent(n: number): RenderLogEntry[] {
    const all = this.entries();
    return all.slice(-n);
  }

  /** Current entry count. */
  get size(): number {
    return this.count;
  }

  /** Clear the log. */
  clear(): void {
    this.buffer = [];
    this.head = 0;
    this.count = 0;
  }
}

/** Singleton render log for the visible café session. */
export const globalRenderLog = new RenderLog();
