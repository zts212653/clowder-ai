/** How long a remembered read is reused at most, before its per-key stagger. */
export const READ_MEMO_LIFETIME_MS = 10 * 60_000;
/** Reads remembered on the same tick expire over this window, not on one tick. */
export const READ_MEMO_STAGGER_MS = 5 * 60_000;
/** A ceiling, not a working size: callers forget a key once it stops needing the read. */
const MAX_ENTRIES = 256;

/** Deterministic per-key offset in [0, READ_MEMO_STAGGER_MS) (FNV-1a). */
export function readMemoStagger(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % READ_MEMO_STAGGER_MS;
}

interface Entry<T> {
  readonly observation: string;
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Reuse a GitHub read while the observation it was taken for is unchanged. A read can depend on
 * more than the observation shows (branch protection, a check run's later output), so a remembered
 * read also expires after a bounded window, staggered per key so that reads remembered together are
 * not all repeated on the same tick.
 */
export class ReadMemo<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  recall(key: string, observation: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.observation !== observation || entry.expiresAt <= this.now()) return undefined;
    return entry.value;
  }

  remember(key: string, observation: string, value: T): void {
    this.entries.delete(key);
    const expiresAt = this.now() + READ_MEMO_LIFETIME_MS + readMemoStagger(key);
    this.entries.set(key, { observation, value, expiresAt });
    const oldest = this.entries.keys().next().value;
    if (this.entries.size > MAX_ENTRIES && oldest !== undefined) this.entries.delete(oldest);
  }

  forget(key: string): void {
    this.entries.delete(key);
  }
}
