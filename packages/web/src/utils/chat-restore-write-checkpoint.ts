import type { SavedScrollState } from './chat-scroll-memory';

/** Epoch-relative monotonic time shared by communicating browser contexts. */
export function chatReadingClock(): number {
  return performance.timeOrigin + performance.now();
}

interface RestoreWrite {
  at: number;
  before: SavedScrollState;
  after: number;
}

/** Transient undo data for this reading owner's uninterrupted restore lifetime. */
export class ChatRestoreWriteCheckpoint {
  private viewport: HTMLElement | null = null;
  private writes: RestoreWrite[] = [];
  private invalidatedAt = chatReadingClock();
  private acceptedInputAt: number | null = null;

  invalidate(): void {
    this.viewport = null;
    this.writes = [];
    this.invalidatedAt = chatReadingClock();
    this.acceptedInputAt = null;
  }

  record(viewport: HTMLElement, before: SavedScrollState, after: number, at: number): void {
    if (before.top === after) return;
    const previous = this.writes.at(-1);
    // Another writer/native scroll breaks the undo chain; never undo its pixels.
    if (this.viewport !== viewport || (previous && previous.after !== before.top)) this.writes = [];
    this.viewport = viewport;
    this.writes.push({ at, before, after });
  }

  acceptsInput(at: number): boolean {
    return Number.isFinite(at) && at >= this.invalidatedAt && at <= chatReadingClock() && at !== this.acceptedInputAt;
  }

  recoveryPosition(viewport: HTMLElement, at: number): SavedScrollState | undefined {
    if (this.viewport !== viewport || this.writes.at(-1)?.after !== viewport.scrollTop) return undefined;
    const firstWriteAfterInput = this.writes.find((write) => write.at >= at);
    return firstWriteAfterInput?.before;
  }

  consumeInput(at: number): void {
    this.viewport = null;
    this.writes = [];
    this.invalidatedAt = at;
    this.acceptedInputAt = at;
  }

  ownsMeasurement(at: number): boolean {
    return at === this.acceptedInputAt;
  }
}
