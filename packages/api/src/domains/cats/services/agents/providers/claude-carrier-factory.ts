/**
 * F198 Phase B Step 3 + Phase D: Carrier factory with health-aware tier selection
 *
 * Phase B (original): Selects `-p` vs `--bg` vs interactive PTY based on env var.
 * Phase D (this change): Adds health-aware fallback — if the target tier is degraded,
 * automatically selects the next healthy tier in the degradation chain (D3).
 *
 * Degradation chain: bg_daemon → interactive_pty → print_sdk → api_key
 *
 * AC-B8 regression pin: no env var + no health state = ClaudeAgentService (-p default).
 * All existing behavior unchanged when no failures are reported.
 *
 * F230 Phase B-hook: `CAT_CAFE_CLAUDE_CARRIER=interactive_pty`
 * Routes to ClaudeInteractivePtyCarrierService — PTY-based carrier using
 * hook sidechannel (Stop/PostToolUse) for output. Works with ANY claude
 * version — no pinned binary required (2.1.170 pin removed).
 */
import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import { ClaudeAgentService } from './ClaudeAgentService.js';
import { ClaudeBgCarrierService } from './ClaudeBgCarrierService.js';
import { ClaudeInteractivePtyCarrierService } from './ClaudeInteractivePtyCarrierService.js';
import {
  CarrierHealthStore,
  type CarrierTier,
  classifyCarrierFailure,
  selectFirstHealthyTier,
} from './carrier-health.js';

export const CARRIER_ENV_KEY = 'CAT_CAFE_CLAUDE_CARRIER';
export const CARRIER_BG_DAEMON = 'bg_daemon';
/** F230: opt-in value for interactive PTY carrier */
export const CARRIER_INTERACTIVE_PTY = 'interactive_pty';
export const CARRIER_PRINT_SDK = 'print_sdk';
export const CARRIER_API_KEY = 'api_key';

// ─── Singleton health store (D2: per-carrier global, not per-cat) ───

let _healthStore: CarrierHealthStore | undefined;

/**
 * Get the singleton CarrierHealthStore.
 * Callers (e.g. invoke-single-cat) use this to report failures after invocation.
 */
export function getCarrierHealthStore(): CarrierHealthStore {
  if (!_healthStore) {
    _healthStore = new CarrierHealthStore();
  }
  return _healthStore;
}

/**
 * Initialize the health store with Redis for restart persistence.
 * Call once during API startup. Safe to skip — store defaults to all-healthy.
 */
export async function initCarrierHealthStore(redis: {
  set(key: string, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}): Promise<void> {
  _healthStore = new CarrierHealthStore(redis);
  await _healthStore.loadFromRedis();
}

/** @internal — test-only: reset singleton for test isolation */
export function _resetHealthStoreForTest(): void {
  _healthStore = undefined;
}

// ─── Carrier construction by tier ───

/**
 * Create the appropriate AgentService for a specific carrier tier.
 * Both `print_sdk` and `api_key` use ClaudeAgentService — the billing difference
 * is in the auth/account layer, not the carrier code.
 */
export function createCarrierByTier(tier: CarrierTier | string, catId: CatId): AgentService {
  switch (tier) {
    case CARRIER_BG_DAEMON:
      return new ClaudeBgCarrierService({ catId });
    case CARRIER_INTERACTIVE_PTY:
      return new ClaudeInteractivePtyCarrierService({ catId });
    case CARRIER_PRINT_SDK:
    case CARRIER_API_KEY:
    default:
      return new ClaudeAgentService({ catId });
  }
}

/**
 * Resolve the target tier from env var.
 * Maps env value to canonical CarrierTier. Unknown values → print_sdk (current default).
 */
function resolveTargetTier(env: Record<string, string | undefined>): CarrierTier {
  const carrier = env[CARRIER_ENV_KEY]?.trim();
  if (carrier === CARRIER_BG_DAEMON) return 'bg_daemon';
  if (carrier === CARRIER_INTERACTIVE_PTY) return 'interactive_pty';
  if (carrier === CARRIER_API_KEY) return 'api_key';
  // Default: print mode (-p), which is the current production path.
  // Unknown env values also fall here (AC-B8 regression pin).
  return 'print_sdk';
}

// ─── Main factory (Phase D upgrade) ───

/**
 * Construct the appropriate Claude carrier for a布偶猫 cat invocation.
 *
 * Phase D upgrade: consults health state to skip degraded tiers.
 * If the target tier (from env) is degraded, walks the chain to the next healthy tier.
 * Returns a FallbackCarrierWrapper that handles in-invocation retry on quota/structural
 * failures and monitors yielded errors for future degradation.
 *
 * @param catId — which布偶猫 instance (opus / sonnet / opus-45 / opus-47)
 * @param env — env vars (defaults to process.env; pass override in tests).
 * @returns FallbackCarrierWrapper that proxies the selected carrier.
 */
export function createClaudeAgentServiceForCanary(
  catId: CatId,
  env: Record<string, string | undefined> = process.env,
): AgentService {
  const store = getCarrierHealthStore();
  const targetTier = resolveTargetTier(env);
  const activeTier = selectFirstHealthyTier(targetTier, store) as CarrierTier;
  const carrier = createCarrierByTier(activeTier, catId);

  return new FallbackCarrierWrapper(carrier, catId, activeTier, targetTier, store);
}

// ─── Fallback wrapper (D3, D4) ───

/**
 * Wraps a carrier with health-aware in-invocation fallback.
 *
 * - Thrown errors: classify → if quota/structural, degrade tier for future,
 *   then retry with next healthy carrier (one retry within same invocation).
 *   Transient errors rethrow — invoke-single-cat handles transient retry.
 *
 * - Yielded error messages: classify → if quota/structural, degrade tier
 *   for NEXT invocation (no mid-stream retry — partial output may exist).
 *
 * - On successful completion of a previously-degraded tier in probe window,
 *   marks it recovered.
 *
 * D4: yields a visible `carrier_fallback` system_info on fallback
 * (NOT in INTERNAL_SYSTEM_INFO_TELEMETRY_TYPES suppress list).
 */
/** @internal — exported for test-only direct construction with mock carriers. */
export class FallbackCarrierWrapper implements AgentService {
  /** Exposed for invoke-single-cat error reporting + existing tests. */
  readonly catId: CatId;
  /** Runtime-only: which tier is actually being used. */
  readonly _carrierTier: CarrierTier;
  /** Runtime-only: original target tier (set only when different from active). */
  readonly _carrierFallbackFrom: CarrierTier | undefined;
  /** @internal — carrier factory, injectable for testing (default: createCarrierByTier). */
  private readonly _carrierFactory: (tier: CarrierTier | string, catId: CatId) => AgentService;

  constructor(
    private readonly carrier: AgentService,
    catId: CatId,
    private readonly activeTier: CarrierTier,
    private readonly targetTier: CarrierTier,
    private readonly store: CarrierHealthStore,
    /** @internal — test-only: override carrier factory for mock injection. */
    carrierFactory?: (tier: CarrierTier | string, catId: CatId) => AgentService,
  ) {
    this.catId = catId;
    this._carrierTier = activeTier;
    this._carrierFallbackFrom = activeTier !== targetTier ? targetTier : undefined;
    this._carrierFactory = carrierFactory ?? createCarrierByTier;
  }

  // ─── Capability probes — proxy from active carrier ───

  injectsL0Natively(): boolean {
    return this.carrier.injectsL0Natively?.() ?? false;
  }

  usesChainKeyResume(): boolean {
    return this.carrier.usesChainKeyResume?.() ?? false;
  }

  needsServerRoutingGuard(): boolean {
    return this.carrier.needsServerRoutingGuard?.() ?? false;
  }

  // ─── Invoke with fallback ───

  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    // Must return AsyncIterable synchronously (not Promise) — AgentService contract.
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return self._invoke(prompt, options);
      },
    };
  }

  private async *_invoke(prompt: string, options?: AgentServiceOptions): AsyncGenerator<AgentMessage> {
    let degradedDuringStream = false;
    try {
      for await (const msg of this.carrier.invoke(prompt, options)) {
        // Monitor yielded errors for quota/structural patterns → degrade for NEXT invocation.
        // No mid-stream retry: partial output may already have been yielded to the user.
        if (msg.type === 'error' && typeof msg.error === 'string') {
          const cls = classifyCarrierFailure(msg.error);
          if (cls !== 'transient') {
            this.store.reportFailure(this.activeTier, cls);
            degradedDuringStream = true;
          }
        }
        yield msg;
      }
      // Successful completion — handle recovery and transient counter reset.
      if (!degradedDuringStream) {
        const healthAfterStream = this.store.getHealth(this.activeTier);
        if (healthAfterStream.state === 'degraded') {
          // Probe window success: TTL expired, state still 'degraded' → mark recovered.
          // P2 fix: use getHealth().state instead of !isHealthy().
          this.store.reportRecovery(this.activeTier);
        } else {
          // Cloud P2 fix: successful stream on healthy tier → reset transient counter.
          // D1 "consecutive" semantics: success breaks the transient failure streak.
          this.store.resetTransientCount(this.activeTier);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const cls = classifyCarrierFailure(errorMsg);

      if (cls === 'transient') {
        // Transient: increment counter but let invoke-single-cat handle retry.
        this.store.reportFailure(this.activeTier, cls);
        throw err;
      }

      // Quota or structural → degrade and try fallback within this invocation.
      this.store.reportFailure(this.activeTier, cls);
      const fallbackTier = selectFirstHealthyTier(this.targetTier, this.store) as CarrierTier;

      if (fallbackTier === this.activeTier) {
        // No better option (all degraded to same point or worse) — rethrow.
        throw err;
      }

      // api_key tier currently uses same carrier as print_sdk (ClaudeAgentService).
      // Auth differentiation (billing layer switch) is PR-2 scope. Until wired,
      // falling back to api_key is a no-op — don't yield a false carrier_fallback event.
      if (fallbackTier === 'api_key') {
        throw err;
      }

      // D4: Yield visible carrier_fallback system_info (NOT suppressed).
      yield {
        type: 'system_info',
        catId: this.catId,
        content: JSON.stringify({
          type: 'carrier_fallback',
          from: this.activeTier,
          to: fallbackTier,
          reason: cls,
          error: errorMsg.slice(0, 200),
        }),
        timestamp: Date.now(),
      };

      // Retry with fallback carrier (one attempt, no further cascading fallback).
      // P1-2 fix: wrap in try-catch to classify and record fallback tier failures.
      // Cloud P1 fix: monitor yielded errors (not just thrown) — carriers can surface
      // quota/structural failures as error messages instead of throwing.
      const fallbackCarrier = this._carrierFactory(fallbackTier, this.catId);
      try {
        for await (const fbMsg of fallbackCarrier.invoke(prompt, options)) {
          if (fbMsg.type === 'error' && typeof fbMsg.error === 'string') {
            const fbCls = classifyCarrierFailure(fbMsg.error);
            if (fbCls !== 'transient') {
              this.store.reportFailure(fallbackTier as CarrierTier, fbCls);
            }
          }
          yield fbMsg;
        }
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        const fbCls = classifyCarrierFailure(fbMsg);
        this.store.reportFailure(fallbackTier as CarrierTier, fbCls);
        throw fallbackErr;
      }
    }
  }
}
