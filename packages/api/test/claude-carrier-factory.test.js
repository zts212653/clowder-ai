/**
 * F198 Phase B Step 3 + F230 B-hook + Phase D: Canary carrier factory test
 *
 * Phase B: Selects ClaudeAgentService (-p, default), ClaudeBgCarrierService (--bg),
 * or ClaudeInteractivePtyCarrierService (interactive_pty) based on env var.
 *
 * Phase D: Factory returns FallbackCarrierWrapper that:
 * - Consults health store to select first healthy tier (D3 degradation chain)
 * - Monitors yielded errors for quota/structural → degrades tier for next invocation
 * - Catches thrown quota/structural errors → retries with fallback carrier (one retry)
 * - Yields visible system_info carrier_fallback on fallback (D4)
 * - Proxies capability probes from inner carrier
 *
 * F230 B-hook: 2.1.170 pin removed — hook sidechannel works with any claude version.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  _resetHealthStoreForTest,
  createCarrierByTier,
  createClaudeAgentServiceForCanary,
  FallbackCarrierWrapper,
  getCarrierHealthStore,
} from '../dist/domains/cats/services/agents/providers/claude-carrier-factory.js';

// ─── Phase B: Tier selection via env (updated to check _carrierTier) ───

describe('canary factory — env-based tier selection', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('env unset → print_sdk tier (default)', () => {
    const service = createClaudeAgentServiceForCanary('opus', {});
    assert.equal(service._carrierTier, 'print_sdk');
  });

  test('env set to non-canary value → print_sdk tier', () => {
    const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'print' });
    assert.equal(service._carrierTier, 'print_sdk');
  });

  test('env CAT_CAFE_CLAUDE_CARRIER=bg_daemon → bg_daemon tier', () => {
    const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    assert.equal(service._carrierTier, 'bg_daemon');
  });

  test('env value with surrounding whitespace handled', () => {
    const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: '  bg_daemon  ' });
    assert.equal(service._carrierTier, 'bg_daemon');
  });

  test('catId is passed through to wrapper', () => {
    const sonnetPrint = createClaudeAgentServiceForCanary('sonnet', {});
    assert.equal(sonnetPrint.catId, 'sonnet');
    const sonnetBg = createClaudeAgentServiceForCanary('sonnet', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    assert.equal(sonnetBg.catId, 'sonnet');
  });

  test('interactive_pty → interactive_pty tier (F230 B-hook, no pin)', () => {
    const service = createClaudeAgentServiceForCanary('opus', {
      CAT_CAFE_CLAUDE_CARRIER: 'interactive_pty',
    });
    assert.equal(service._carrierTier, 'interactive_pty');
    assert.equal(service.catId, 'opus');
  });
});

// ─── Phase D: FallbackCarrierWrapper behavior ───

describe('FallbackCarrierWrapper — wrapper contract', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('wrapper is FallbackCarrierWrapper (not raw carrier class)', () => {
    const service = createClaudeAgentServiceForCanary('opus', {});
    assert.equal(service.constructor.name, 'FallbackCarrierWrapper');
  });

  test('invoke() returns AsyncIterable synchronously (AgentService contract)', () => {
    const service = createClaudeAgentServiceForCanary('opus', {});
    const iter = service.invoke('test prompt');
    assert.ok(typeof iter[Symbol.asyncIterator] === 'function', 'must be AsyncIterable directly');
  });

  test('no fallback from target → _carrierFallbackFrom is undefined', () => {
    const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    assert.equal(service._carrierFallbackFrom, undefined);
  });

  test('health degradation causes tier skip → _carrierFallbackFrom is set', () => {
    const store = getCarrierHealthStore();
    store.reportFailure('bg_daemon', 'quota');
    const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    assert.equal(service._carrierTier, 'interactive_pty');
    assert.equal(service._carrierFallbackFrom, 'bg_daemon');
  });
});

describe('FallbackCarrierWrapper — capability probe proxying', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('injectsL0Natively proxied from inner carrier', () => {
    // bg_daemon carrier has injectsL0Natively
    const bg = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    // print_sdk carrier (ClaudeAgentService) has injectsL0Natively
    const print = createClaudeAgentServiceForCanary('opus', {});
    // Both should return boolean (may be true or false depending on implementation)
    assert.equal(typeof bg.injectsL0Natively(), 'boolean');
    assert.equal(typeof print.injectsL0Natively(), 'boolean');
  });

  test('usesChainKeyResume proxied from inner carrier', () => {
    // bg_daemon uses chain key resume
    const bg = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    assert.equal(bg.usesChainKeyResume(), true, 'bg_daemon uses chain key resume');
    // print_sdk does not
    const print = createClaudeAgentServiceForCanary('opus', {});
    assert.equal(print.usesChainKeyResume(), false, 'print_sdk does not use chain key resume');
  });
});

describe('createCarrierByTier — direct construction', () => {
  test('bg_daemon → ClaudeBgCarrierService', () => {
    const svc = createCarrierByTier('bg_daemon', 'opus');
    assert.equal(svc.constructor.name, 'ClaudeBgCarrierService');
  });

  test('interactive_pty → ClaudeInteractivePtyCarrierService', () => {
    const svc = createCarrierByTier('interactive_pty', 'opus');
    assert.equal(svc.constructor.name, 'ClaudeInteractivePtyCarrierService');
  });

  test('print_sdk → ClaudeAgentService', () => {
    const svc = createCarrierByTier('print_sdk', 'opus');
    assert.equal(svc.constructor.name, 'ClaudeAgentService');
  });

  test('api_key → ClaudeAgentService', () => {
    const svc = createCarrierByTier('api_key', 'opus');
    assert.equal(svc.constructor.name, 'ClaudeAgentService');
  });
});

// ─── Phase D: In-invocation fallback integration ───

describe('FallbackCarrierWrapper — in-invocation fallback (D3/D4)', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('yielded quota error degrades tier for next invocation', async () => {
    const store = getCarrierHealthStore();
    // Create a mock carrier that yields a quota error message
    const mockCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          yield { type: 'error', catId: 'opus', error: '429 rate limit exceeded', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now(), metadata: { provider: 'mock', model: 'm' } };
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(mockCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);

    const events = [];
    for await (const msg of wrapper.invoke('test')) events.push(msg);

    // Error message should pass through
    assert.equal(events[0].type, 'error');
    // bg_daemon should now be degraded
    assert.equal(store.isHealthy('bg_daemon'), false);
  });

  test('thrown quota error → degrades tier + yields system_info + attempts fallback', async () => {
    const store = getCarrierHealthStore();
    // Pre-degrade interactive_pty so fallback skips to print_sdk (ClaudeAgentService),
    // which fails fast in test env (~1s) instead of interactive_pty's 300s timeout.
    store.reportFailure('interactive_pty', 'structural');

    // Mock carrier that throws quota error on iteration
    const throwingCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          throw new Error('You have reached your usage limit. Please wait.');
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(throwingCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);
    const events = [];

    // The wrapper catches the quota error, degrades bg_daemon, then tries to create
    // a real fallback carrier (print_sdk = ClaudeAgentService). That real carrier will
    // also fail in test (no meaningful prompt/session), but we verify the system_info
    // event was yielded first and health state was updated.
    try {
      for await (const msg of wrapper.invoke('test')) events.push(msg);
    } catch {
      // Expected: fallback carrier also fails without real CLI session
    }

    // bg_daemon should be degraded
    assert.equal(store.isHealthy('bg_daemon'), false);

    // system_info carrier_fallback event should have been yielded before fallback attempt
    const sysInfo = events.find((e) => e.type === 'system_info');
    assert.ok(sysInfo, 'should yield system_info carrier_fallback event');
    const payload = JSON.parse(sysInfo.content);
    assert.equal(payload.type, 'carrier_fallback');
    assert.equal(payload.from, 'bg_daemon');
    assert.equal(payload.to, 'print_sdk'); // skipped degraded interactive_pty
    assert.equal(payload.reason, 'quota');
    assert.ok(payload.error.includes('usage limit'), 'error snippet included');
  });

  test('thrown transient error rethrows without degradation', async () => {
    const store = getCarrierHealthStore();
    const throwingCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          throw new Error('ECONNRESET: connection reset by peer');
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(throwingCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);

    try {
      for await (const _msg of wrapper.invoke('test')) {
        /* drain */
      }
      assert.fail('Should have rethrown');
    } catch (err) {
      assert.ok(err.message.includes('ECONNRESET'));
      // bg_daemon should still be healthy (single transient doesn't degrade)
      assert.equal(store.isHealthy('bg_daemon'), true);
    }
  });

  test('thrown structural error with only api_key remaining → rethrows (api_key guard)', async () => {
    const store = getCarrierHealthStore();
    // Degrade everything except api_key and the active tier
    store.reportFailure('interactive_pty', 'structural');
    store.reportFailure('print_sdk', 'structural');

    const throwingCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          throw new Error('claude --bg spawn failed: spawn claude ENOENT');
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(throwingCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);

    const events = [];
    try {
      for await (const msg of wrapper.invoke('test')) events.push(msg);
      assert.fail('Should have rethrown');
    } catch (_err) {
      // bg_daemon degraded
      assert.equal(store.isHealthy('bg_daemon'), false);
      // api_key guard: no system_info carrier_fallback — api_key auth not wired (PR-2)
      const sysInfo = events.find((e) => e.type === 'system_info');
      assert.equal(sysInfo, undefined, 'should NOT yield carrier_fallback to api_key');
    }
  });
});

// ─── @gpt52 review: P1-2 + P2 bug reproductions (Red→Green TDD) ───

describe('FallbackCarrierWrapper — @gpt52 review bug fixes', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('P1-2: fallback carrier failure is classified and recorded in health store', async () => {
    const store = getCarrierHealthStore();

    // Primary carrier throws structural error → triggers fallback to interactive_pty
    const primaryCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          throw new Error('claude --bg spawn failed: spawn claude ENOENT');
        })();
      },
    };

    // Mock fallback factory: returns a carrier that ALSO throws structural
    const mockFallbackFactory = (_tier, catId) => ({
      catId,
      invoke() {
        return (async function* () {
          throw new Error('claude -p exited code=1: config parse error');
        })();
      },
    });

    const wrapper = new FallbackCarrierWrapper(
      primaryCarrier,
      'opus',
      'bg_daemon',
      'bg_daemon',
      store,
      mockFallbackFactory,
    );

    let caughtError;
    try {
      for await (const _msg of wrapper.invoke('test')) {
        /* drain */
      }
    } catch (err) {
      caughtError = err;
    }

    // Error should propagate (rethrown after recording)
    assert.ok(caughtError, 'fallback error should be rethrown');
    assert.ok(caughtError.message.includes('exited code=1'), 'should be the fallback error');

    // Primary failure IS recorded (existing behavior, sanity check)
    assert.equal(store.isHealthy('bg_daemon'), false, 'primary tier (bg_daemon) should be degraded');

    // P1-2: fallback tier (interactive_pty) failure should ALSO be classified and recorded.
    // bg_daemon is degraded → selectFirstHealthyTier walks to interactive_pty.
    // Mock fallback throws structural → should be recorded for interactive_pty.
    const fallbackHealth = store.getHealth('interactive_pty');
    assert.equal(
      fallbackHealth.state,
      'degraded',
      'fallback tier (interactive_pty) failure should be recorded in health store',
    );
  });

  test('P2: successful stream on probe-window tier triggers recovery', async () => {
    const store = getCarrierHealthStore();
    // Manually create an expired degraded state (probe window).
    // getHealth() returns degraded; isHealthy() returns true (TTL expired).
    // biome-ignore lint/complexity/useLiteralKeys: accessing private cache for test
    store['cache'].set('bg_daemon', {
      state: 'degraded',
      reason: 'structural',
      since: Date.now() - 60 * 60 * 1000, // degraded 1h ago
      retryAfter: Date.now() - 1000, // TTL expired = probe window
    });

    // Sanity: probe window state
    assert.equal(store.isHealthy('bg_daemon'), true, 'probe window: isHealthy should be true');
    assert.equal(store.getHealth('bg_daemon').state, 'degraded', 'but raw state is still degraded');

    // Mock carrier that completes successfully (probe success)
    const successCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          yield { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(successCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);
    for await (const _msg of wrapper.invoke('test')) {
      /* drain */
    }

    // BUG P2: current condition `!this.store.isHealthy(this.activeTier)` evaluates to
    // false in probe window (isHealthy returns true for expired TTL), so recovery
    // is NEVER triggered. After fix: uses getHealth().state === 'degraded' instead.
    const healthAfter = store.getHealth('bg_daemon');
    assert.equal(healthAfter.state, 'healthy', 'probe-window success should trigger recovery');
  });
});

// ─── @gpt52 R2: api_key fallback guard (auth not wired in PR-1) ───

describe('FallbackCarrierWrapper — api_key fallback guard', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('api_key fallback is skipped when auth is not differentiated (rethrows original error)', async () => {
    const store = getCarrierHealthStore();
    // Degrade all tiers except api_key → selectFirstHealthyTier returns 'api_key'
    store.reportFailure('interactive_pty', 'structural');
    store.reportFailure('print_sdk', 'structural');

    const throwingCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          throw new Error('claude --bg spawn failed: spawn claude ENOENT');
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(throwingCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);

    const events = [];
    let caughtError;
    try {
      for await (const msg of wrapper.invoke('test')) events.push(msg);
    } catch (err) {
      caughtError = err;
    }

    // Should rethrow the original error, NOT fall back to api_key
    assert.ok(caughtError, 'should rethrow when api_key is only option');
    assert.ok(caughtError.message.includes('spawn failed'), 'should be the original error');

    // No system_info carrier_fallback event (fallback was skipped)
    const sysInfo = events.find((e) => e.type === 'system_info');
    assert.equal(sysInfo, undefined, 'should NOT yield carrier_fallback to api_key');

    // bg_daemon should be degraded (primary failure recorded)
    assert.equal(store.isHealthy('bg_daemon'), false, 'primary tier degraded');
  });
});

// ─── Cloud review: P1 + P2 (fallback yield monitoring + transient counter reset) ───

describe('FallbackCarrierWrapper — cloud review fixes', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('cloud P1: fallback carrier yielded error is classified and recorded in health store', async () => {
    const store = getCarrierHealthStore();

    // Primary carrier throws structural → triggers fallback
    const primaryCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          throw new Error('claude --bg spawn failed: spawn claude ENOENT');
        })();
      },
    };

    // Fallback carrier YIELDS a quota error message (doesn't throw)
    const mockFallbackFactory = (_tier, catId) => ({
      catId,
      invoke() {
        return (async function* () {
          yield { type: 'error', catId, error: '429 rate limit exceeded', timestamp: Date.now() };
          yield { type: 'done', catId, timestamp: Date.now(), metadata: { provider: 'mock', model: 'm' } };
        })();
      },
    });

    const wrapper = new FallbackCarrierWrapper(
      primaryCarrier,
      'opus',
      'bg_daemon',
      'bg_daemon',
      store,
      mockFallbackFactory,
    );

    const events = [];
    for await (const msg of wrapper.invoke('test')) events.push(msg);

    // Primary tier (bg_daemon) degraded — sanity check
    assert.equal(store.isHealthy('bg_daemon'), false, 'primary tier degraded');

    // Cloud P1: fallback tier (interactive_pty) yielded a quota error →
    // should be classified and recorded in health store.
    const fallbackHealth = store.getHealth('interactive_pty');
    assert.equal(fallbackHealth.state, 'degraded', 'fallback tier yielded quota error must be recorded');
  });

  test('cloud P2: successful stream resets transient counter (consecutive semantics)', async () => {
    const store = getCarrierHealthStore();

    // Report 2 transient failures for bg_daemon (below 3-consecutive threshold)
    store.reportFailure('bg_daemon', 'transient');
    store.reportFailure('bg_daemon', 'transient');
    // Tier should still be healthy (below threshold)
    assert.equal(store.isHealthy('bg_daemon'), true, 'below threshold = still healthy');

    // Successful stream should reset the transient counter
    const successCarrier = {
      catId: 'opus',
      invoke() {
        return (async function* () {
          yield { type: 'text', catId: 'opus', content: 'ok', timestamp: Date.now() };
        })();
      },
    };

    const wrapper = new FallbackCarrierWrapper(successCarrier, 'opus', 'bg_daemon', 'bg_daemon', store);
    for await (const _msg of wrapper.invoke('test')) {
      /* drain */
    }

    // Now report one more transient failure. If the counter was properly reset,
    // the tier should still be healthy (count = 1, not 3).
    store.reportFailure('bg_daemon', 'transient');
    assert.equal(
      store.isHealthy('bg_daemon'),
      true,
      'transient counter should have been reset by successful stream — one new transient should NOT degrade',
    );
  });
});

// ─── Regression pin (AC-B8): no health state = current behavior ───

describe('regression: factory with fresh health store = current behavior', () => {
  beforeEach(() => {
    _resetHealthStoreForTest();
  });

  test('no health state → same tier as env specifies (zero change)', () => {
    const print = createClaudeAgentServiceForCanary('opus', {});
    assert.equal(print._carrierTier, 'print_sdk');

    const bg = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
    assert.equal(bg._carrierTier, 'bg_daemon');

    const pty = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'interactive_pty' });
    assert.equal(pty._carrierTier, 'interactive_pty');
  });

  test('no health state → no _carrierFallbackFrom (no fallback happened)', () => {
    const service = createClaudeAgentServiceForCanary('opus', {});
    assert.equal(service._carrierFallbackFrom, undefined);
  });
});

// ─── Legacy: opusService lazy wrapper contract (砚砚 Step-3 P1) ───

test('砚砚 Step-3 P1 re-review: opusService lazy wrapper invoke() returns AsyncIterable directly (not Promise)', () => {
  let inited = false;
  const factory = (catId) => {
    inited = true;
    return {
      catId,
      async *invoke() {
        yield { type: 'done', catId, timestamp: Date.now(), metadata: { provider: 'mock', model: 'm' } };
      },
    };
  };
  let _svc;
  const lazyService = {
    invoke(prompt, options) {
      return (async function* () {
        if (!_svc) _svc = factory('opus');
        yield* _svc.invoke(prompt, options);
      })();
    },
  };
  const iter = lazyService.invoke('hi');
  assert.ok(typeof iter[Symbol.asyncIterator] === 'function', 'must be AsyncIterable directly');
  assert.equal(inited, false, 'lazy init must NOT happen at invoke() call time');
});

test('砚砚 Step-3 P1 re-review: opusService lazy wrapper executes lazy init on first yield', async () => {
  let inited = 0;
  const factory = () => {
    inited++;
    return {
      catId: 'opus',
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'lazy ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now(), metadata: { provider: 'mock', model: 'm' } };
      },
    };
  };
  let _svc;
  const lazyService = {
    invoke(prompt, options) {
      return (async function* () {
        if (!_svc) _svc = factory();
        yield* _svc.invoke(prompt, options);
      })();
    },
  };

  const events = [];
  for await (const msg of lazyService.invoke('hi')) events.push(msg);
  assert.equal(inited, 1, 'lazy init exactly once');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'text');
  assert.equal(events[1].type, 'done');

  for await (const _ of lazyService.invoke('hi2')) {
    // drain
  }
  assert.equal(inited, 1, 'lazy init still exactly once after second invoke');
});
