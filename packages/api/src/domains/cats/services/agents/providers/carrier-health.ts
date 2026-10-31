/**
 * F198 Phase D: Carrier health state machine + failure classifier + tier selection
 *
 * Design decisions (Fable-5 plan, D1-D7 — all final, not reopened):
 *
 * D1 — Failure classification: quota (sticky 4h) / structural (sticky 30min) / transient (no degrade, 3x→structural)
 * D2 — Health state is per-carrier global, not per-cat (quota = account-level, binary = machine-level)
 * D3 — Degradation chain: bg_daemon → interactive_pty → print_sdk → api_key
 * D4 — Degradation yields visible system_info carrier_fallback event (NOT suppressed)
 * D5 — Rollout config in Redis (PR-2)
 *
 * Architecture: in-memory state with fire-and-forget Redis sync for restart persistence.
 * Factory reads from in-memory cache (sync). On failure, writes to both memory and Redis.
 */

// ─── Types ───

export type CarrierTier = 'bg_daemon' | 'interactive_pty' | 'print_sdk' | 'api_key';
export type FailureClass = 'quota' | 'structural' | 'transient';

export interface DegradedState {
  state: 'degraded';
  reason: FailureClass;
  since: number;
  retryAfter: number;
}

export type HealthState = { state: 'healthy' } | DegradedState;

// ─── Constants ───

/** Fixed degradation chain (D3). bg is primary, api_key is last resort. */
export const DEGRADATION_CHAIN: CarrierTier[] = ['bg_daemon', 'interactive_pty', 'print_sdk', 'api_key'];

/** Quota TTL: 4 hours (D1). Quota is account-level — once hit, all cats are blocked. */
const QUOTA_TTL_MS = 4 * 60 * 60 * 1000;

/** Structural TTL: 30 minutes (D1). Binary/config issues may self-heal after deploy/restart. */
const STRUCTURAL_TTL_MS = 30 * 60 * 1000;

/** Consecutive transient failures before upgrading to structural (D1). */
const TRANSIENT_UPGRADE_THRESHOLD = 3;

// ─── Classifier (D1) — table-driven, calibrated from real carrier error strings ───

/**
 * Patterns for quota-class failures.
 * Sources: claude CLI rate limit banner, SDK 429, AcpClient MODEL_CAPACITY_EXHAUSTED.
 * OQ: real error strings may vary — recalibrate from production logs post-deploy.
 */
const QUOTA_PATTERNS: RegExp[] = [
  /usage[\s_-]*limit/i,
  /rate[\s_-]*limit/i,
  /\b429\b/,
  /weekly[\s_-]*limit/i,
  /credit/i,
  /capacity[\s_-]*exhausted/i,
  /no[\s_-]*capacity[\s_-]*available/i,
];

/**
 * Patterns for structural-class failures.
 * Sources: ClaudeBgCarrierService CarrierError (spawn/exit/parse/L0),
 *          ClaudeInteractivePtyCarrierService spawn failures.
 */
const STRUCTURAL_PATTERNS: RegExp[] = [
  /spawn[\s_-]*failed/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /could not parse short id/i,
  /L0 compile failed/i,
  /command not found/i,
  /exited code=(?!0\b)\d+/i, // non-zero exit code (but not code=0)
  /transcript read failed/i,
];

/**
 * Classify a carrier failure into one of three classes (D1).
 *
 * - quota: subscription/credit limit hit → sticky degradation (4h TTL)
 * - structural: binary/config/compilation issue → sticky degradation (30min TTL)
 * - transient: network/timeout/abort → no immediate degradation (3 consecutive → structural)
 *
 * Default: transient (unknown errors don't trigger degradation).
 */
export function classifyCarrierFailure(error: string | Error): FailureClass {
  const msg = error instanceof Error ? error.message : error;
  for (const pattern of QUOTA_PATTERNS) {
    if (pattern.test(msg)) return 'quota';
  }
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(msg)) return 'structural';
  }
  return 'transient';
}

// ─── Health Store (D2) ───

/**
 * Minimal Redis client interface — only the methods we need for fire-and-forget sync.
 * Avoids importing the full Redis client in unit tests.
 */
interface RedisLike {
  set(key: string, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * Per-carrier health state machine (D2).
 *
 * In-memory primary, with optional Redis persistence for restart survival.
 * api_key tier is hardcoded healthy (last resort, pay-per-use, no subscription limit).
 *
 * State transitions:
 *   healthy → degraded(reason, since, retryAfter)  — on quota/structural failure
 *   degraded → healthy                             — on explicit recovery or TTL expiry (probe window)
 *   transient × 3 → structural degradation         — consecutive transient escalation
 */
export class CarrierHealthStore {
  private readonly cache = new Map<CarrierTier, DegradedState>();
  private readonly transientCounts = new Map<CarrierTier, number>();
  private readonly redis?: RedisLike;

  constructor(redis?: RedisLike) {
    this.redis = redis;
  }

  /** Get the health state for a tier. api_key always returns healthy. */
  getHealth(tier: CarrierTier): HealthState {
    if (tier === 'api_key') return { state: 'healthy' };
    const degraded = this.cache.get(tier);
    if (!degraded) return { state: 'healthy' };
    return degraded;
  }

  /**
   * Check if a tier is currently usable.
   * Returns true if healthy, or if degraded but TTL has expired (probe window).
   * api_key always returns true.
   */
  isHealthy(tier: CarrierTier): boolean {
    if (tier === 'api_key') return true;
    const health = this.getHealth(tier);
    if (health.state === 'healthy') return true;
    // TTL expired → probe window: let next invocation try this tier
    return Date.now() >= health.retryAfter;
  }

  /**
   * Report a carrier failure. Updates health state based on failure class (D1).
   *
   * - quota → immediate degradation, 4h TTL
   * - structural → immediate degradation, 30min TTL
   * - transient → increment counter; 3 consecutive → upgrade to structural
   */
  reportFailure(tier: CarrierTier, cls: FailureClass): void {
    if (tier === 'api_key') return; // can't degrade last resort

    if (cls === 'transient') {
      const count = (this.transientCounts.get(tier) ?? 0) + 1;
      this.transientCounts.set(tier, count);
      if (count < TRANSIENT_UPGRADE_THRESHOLD) {
        return; // don't degrade on fewer than threshold transient failures
      }
      // Upgrade to structural after threshold consecutive transients
      cls = 'structural';
    }

    // Clear transient count on non-transient degradation
    this.transientCounts.delete(tier);

    const ttl = cls === 'quota' ? QUOTA_TTL_MS : STRUCTURAL_TTL_MS;
    const now = Date.now();
    const state: DegradedState = {
      state: 'degraded',
      reason: cls,
      since: now,
      retryAfter: now + ttl,
    };
    this.cache.set(tier, state);
    this.syncToRedis(tier, state);
  }

  /**
   * Reset the transient failure counter for a tier.
   * Called on successful stream completion to enforce D1 "consecutive" semantics —
   * a successful invocation breaks the transient failure streak.
   */
  resetTransientCount(tier: CarrierTier): void {
    this.transientCounts.delete(tier);
  }

  /** Report recovery — tier is healthy again. Clears degradation and transient count. */
  reportRecovery(tier: CarrierTier): void {
    this.cache.delete(tier);
    this.transientCounts.delete(tier);
    this.syncToRedis(tier, null);
  }

  /**
   * Load persisted health state from Redis on startup.
   * Call once during API initialization. Failures are silent (fresh start = all healthy).
   */
  async loadFromRedis(): Promise<void> {
    if (!this.redis) return;
    for (const tier of DEGRADATION_CHAIN) {
      if (tier === 'api_key') continue;
      try {
        const raw = await this.redis.get(`carrier:health:${tier}`);
        if (raw) {
          const parsed = JSON.parse(raw) as DegradedState;
          // Only restore if TTL hasn't expired
          if (parsed.retryAfter > Date.now()) {
            this.cache.set(tier, parsed);
          }
        }
      } catch {
        // Silent — fresh start for this tier
      }
    }
  }

  // ─── Private ───

  private syncToRedis(tier: CarrierTier, state: DegradedState | null): void {
    if (!this.redis) return;
    const key = `carrier:health:${tier}`;
    if (state) {
      this.redis.set(key, JSON.stringify(state)).catch(() => {});
    } else {
      this.redis.del(key).catch(() => {});
    }
  }
}

// ─── Tier Selection (D3) ───

/**
 * Walk the degradation chain from `target` to find the first healthy tier.
 * If target is not in the chain (unknown value), return it as-is (no-op, safe default).
 * api_key is always the last resort and always healthy.
 */
export function selectFirstHealthyTier(target: CarrierTier | string, store: CarrierHealthStore): CarrierTier | string {
  const idx = DEGRADATION_CHAIN.indexOf(target as CarrierTier);
  if (idx === -1) return target; // unknown tier, pass through
  for (let i = idx; i < DEGRADATION_CHAIN.length; i++) {
    if (store.isHealthy(DEGRADATION_CHAIN[i])) {
      return DEGRADATION_CHAIN[i];
    }
  }
  return 'api_key'; // unreachable (api_key is always healthy), but defensive
}
