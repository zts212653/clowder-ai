/**
 * B-6: Dismiss-rate tracker for guide offers.
 *
 * Tracks how many times each user has dismissed (cancelled) a specific
 * guide offer. The GuideOfferPolicy uses this count to suppress
 * re-offers after too many dismissals.
 *
 * Guide state is runtime-only — dismiss counts reset on restart.
 * Port interface + in-memory implementation.
 */

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface IGuideDismissTracker {
  /** Get dismiss counts for a user across all guides. */
  getDismissCounts(userId: string, guideIds: string[]): Promise<Record<string, number>>;
  /** Increment dismiss count for a specific user + guide pair. */
  incrementDismiss(userId: string, guideId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-Memory Implementation (guide state is runtime-only)
// ---------------------------------------------------------------------------

export class InMemoryGuideDismissTracker implements IGuideDismissTracker {
  private readonly counts = new Map<string, number>();

  private key(userId: string, guideId: string): string {
    return `${userId}:${guideId}`;
  }

  async getDismissCounts(userId: string, guideIds: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const guideId of guideIds) {
      const count = this.counts.get(this.key(userId, guideId));
      if (count) result[guideId] = count;
    }
    return result;
  }

  async incrementDismiss(userId: string, guideId: string): Promise<void> {
    const k = this.key(userId, guideId);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
}
