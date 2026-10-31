/**
 * F167 Phase O PR-O2b: Bounded Sample Store
 *
 * Stores a bounded sample of ClaimGroundingEvents for F192 eval
 * consumption. Sampling rules (spec R2 + R3):
 *
 * - mismatch & wouldBlock: 100% keep (always diagnostically valuable)
 * - insufficient: cap 3 per resolver×thread×day (prevent flood)
 * - verified: 1/20 rate + global daily cap (baseline sampling)
 *
 * Process-local (in-memory) — API restart clears samples.
 * PR-O4 scope-cut: existing diagnostics (traces, metrics) have Redis-backed
 * persistence; this store should align to 7-day retention per spec L826.
 * Deferred to PR-O4 hardening — shadow-week observation is viable without
 * restart durability, but enforcement phase will need it.
 */

import type { ClaimGroundingEvent } from './types.js';

// ── Day key helper ───────────────────────────────────────────

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── Options ──────────────────────────────────────────────────

export interface GroundingSampleStoreOptions {
  /** Maximum total events stored (FIFO eviction on overflow). Default: 1000. */
  maxTotal?: number;
  /** Insufficient cap per resolver×thread×day. Default: 3. */
  insufficientCap?: number;
  /** Verified sampling rate (1 in N). Default: 20. */
  verifiedSampleRate?: number;
  /** Verified global daily cap. Default: 50. */
  verifiedDailyCap?: number;
  /**
   * Injectable sampler for verified events (deterministic testing).
   * Default: Math.random() < 1/verifiedSampleRate.
   */
  shouldSampleVerified?: () => boolean;
}

// ── Store ────────────────────────────────────────────────────

export class GroundingSampleStore {
  private readonly samples: ClaimGroundingEvent[] = [];
  private readonly maxTotal: number;
  private readonly insufficientCap: number;
  private readonly verifiedDailyCap: number;
  private readonly shouldSampleVerified: () => boolean;

  /** Track insufficient counts: key = `${resolver}:${threadId}:${dayKey}` → count. */
  private readonly insufficientCounts = new Map<string, number>();

  /** Track verified daily counts: key = dayKey → count. */
  private readonly verifiedDayCounts = new Map<string, number>();

  /** Total events dropped (for stats). */
  private dropped = 0;

  constructor(opts: GroundingSampleStoreOptions = {}) {
    this.maxTotal = opts.maxTotal ?? 1000;
    this.insufficientCap = opts.insufficientCap ?? 3;
    this.verifiedDailyCap = opts.verifiedDailyCap ?? 50;

    const rate = opts.verifiedSampleRate ?? 20;
    this.shouldSampleVerified = opts.shouldSampleVerified ?? (() => Math.random() < 1 / rate);
  }

  /**
   * Record a grounding event if it passes sampling rules.
   *
   * @param event The grounding event to potentially store.
   * @param wouldBlock Whether enforcement would have blocked this action.
   */
  record(event: ClaimGroundingEvent, wouldBlock: boolean): void {
    if (this.shouldRecord(event, wouldBlock)) {
      this.push(event);
    } else {
      this.dropped++;
    }
  }

  /** Get all stored samples (defensive copy). */
  getSamples(): ClaimGroundingEvent[] {
    return [...this.samples];
  }

  /** Get sampling statistics. */
  getStats(): { stored: number; dropped: number } {
    return { stored: this.samples.length, dropped: this.dropped };
  }

  // ── Private ──────────────────────────────────────────────

  private shouldRecord(event: ClaimGroundingEvent, wouldBlock: boolean): boolean {
    // Rule 1: mismatch or wouldBlock → always keep (100%)
    if (event.verdict === 'mismatch' || wouldBlock) {
      return true;
    }

    // Rule 2: insufficient → cap 3 per resolver×thread×day
    if (event.verdict === 'insufficient') {
      return this.checkInsufficientCap(event);
    }

    // Rule 3: verified → 1/N rate + daily cap
    if (event.verdict === 'verified') {
      return this.checkVerifiedSampling(event);
    }

    // Unknown verdict — store it (shouldn't happen with current type system)
    return true;
  }

  private checkInsufficientCap(event: ClaimGroundingEvent): boolean {
    const key = `${event.resolver}:${event.threadId}:${dayKey(event.ts)}`;
    const count = this.insufficientCounts.get(key) ?? 0;
    if (count >= this.insufficientCap) {
      return false;
    }
    this.insufficientCounts.set(key, count + 1);
    return true;
  }

  private checkVerifiedSampling(event: ClaimGroundingEvent): boolean {
    // Check daily cap first
    const day = dayKey(event.ts);
    const dayCount = this.verifiedDayCounts.get(day) ?? 0;
    if (dayCount >= this.verifiedDailyCap) {
      return false;
    }

    // Then check probabilistic sampling
    if (!this.shouldSampleVerified()) {
      return false;
    }

    this.verifiedDayCounts.set(day, dayCount + 1);
    return true;
  }

  private push(event: ClaimGroundingEvent): void {
    // FIFO eviction if at capacity
    if (this.samples.length >= this.maxTotal) {
      this.samples.shift();
      this.dropped++;
    }
    this.samples.push(event);
  }
}
