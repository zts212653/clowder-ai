import type { WeChatVisibleErrorCode, WeChatVisibleReadResult } from './types.js';

const RECENT_WINDOW_SIZE = 20;
const PASSIVE_LAYOUT_SUCCESS_FLOOR = 0.8;

export interface WeChatVisibleReaderMetricsSnapshot {
  totalReadAttempts: number;
  totalSuccesses: number;
  typedErrors: Partial<Record<WeChatVisibleErrorCode, number>>;
  recentWindowSize: number;
  recentSuccessRate: number | null;
  layoutPauseRecommended: boolean;
}

/** Privacy-safe runtime telemetry: outcomes only, never OCR text, hashes, or screenshots. */
export class WeChatVisibleReaderMetrics {
  private totalReadAttempts = 0;
  private totalSuccesses = 0;
  private readonly typedErrors: Partial<Record<WeChatVisibleErrorCode, number>> = {};
  private readonly recentSuccesses: boolean[] = [];

  record(result: WeChatVisibleReadResult): void {
    this.totalReadAttempts += 1;
    this.recentSuccesses.push(result.ok);
    if (this.recentSuccesses.length > RECENT_WINDOW_SIZE) this.recentSuccesses.shift();

    if (result.ok) {
      this.totalSuccesses += 1;
      return;
    }
    this.typedErrors[result.error.code] = (this.typedErrors[result.error.code] ?? 0) + 1;
  }

  snapshot(): WeChatVisibleReaderMetricsSnapshot {
    const recentWindowSize = this.recentSuccesses.length;
    const recentSuccessRate =
      recentWindowSize === 0 ? null : this.recentSuccesses.filter((success) => success).length / recentWindowSize;
    return {
      totalReadAttempts: this.totalReadAttempts,
      totalSuccesses: this.totalSuccesses,
      typedErrors: { ...this.typedErrors },
      recentWindowSize,
      recentSuccessRate,
      layoutPauseRecommended:
        recentWindowSize === RECENT_WINDOW_SIZE &&
        recentSuccessRate !== null &&
        recentSuccessRate < PASSIVE_LAYOUT_SUCCESS_FLOOR,
    };
  }
}
