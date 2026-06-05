/**
 * F192 Phase G AC-G13 — Cancel Burst Detector.
 *
 * Tracks permission cancel frequency per thread. When ≥ threshold
 * cancels occur within a sliding window, signals a "cancel burst" —
 * a mechanical interrupt proxy signal indicating sustained user dissatisfaction.
 *
 * In-memory only (process-local). Resets on restart. This is intentional:
 * burst detection is a transient real-time signal, not persisted state.
 */

export interface CancelBurstConfig {
  /** Number of cancels within window to trigger burst. Default: 3 */
  threshold: number;
  /** Sliding window in ms. Default: 60_000 (1 minute) */
  windowMs: number;
}

export interface CancelBurstResult {
  burst: boolean;
  count: number;
}

export class CancelBurstDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  /** threadId → array of cancel timestamps (within window) */
  private windows = new Map<string, number[]>();

  constructor(config: CancelBurstConfig) {
    this.threshold = config.threshold;
    this.windowMs = config.windowMs;
  }

  /**
   * Record a cancel event. Returns whether this triggers a burst.
   * After a burst fires, the window resets for that thread.
   */
  record(threadId: string, timestamp: number): CancelBurstResult {
    let timestamps = this.windows.get(threadId) ?? [];

    // Evict entries outside the window
    const cutoff = timestamp - this.windowMs;
    timestamps = timestamps.filter((t) => t > cutoff);

    // Add current
    timestamps.push(timestamp);

    if (timestamps.length >= this.threshold) {
      // Burst detected — reset window
      this.windows.set(threadId, []);
      return { burst: true, count: timestamps.length };
    }

    this.windows.set(threadId, timestamps);
    return { burst: false, count: timestamps.length };
  }
}
