/**
 * F198 Phase D: Carrier health state machine + failure classifier + tier selection
 *
 * TDD: RED first, GREEN after implementing carrier-health.ts
 *
 * D1: Failure classification — quota (sticky 4h) / structural (sticky 30min) / transient (retry, 3x→structural)
 * D2: Health state per-carrier, not per-cat (quota = account-level, binary = machine-level)
 * D3: Degradation chain: bg_daemon → interactive_pty → print_sdk → api_key
 * D4: carrier_fallback event is user-visible system_info
 * D5: Rollout config in Redis (PR-2)
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// Will be implemented in carrier-health.ts
import {
  CarrierHealthStore,
  classifyCarrierFailure,
  DEGRADATION_CHAIN,
  selectFirstHealthyTier,
} from '../dist/domains/cats/services/agents/providers/carrier-health.js';

// ─── Step 1: Classifier table-driven tests (D1, ≥9 real error samples) ───

describe('classifyCarrierFailure — quota class', () => {
  const quotaSamples = [
    // Claude CLI rate limit banner (observed in spike)
    'You have reached your usage limit. Please wait before trying again.',
    // Claude SDK-style 429
    'Error: 429 Too Many Requests - rate limit exceeded',
    // Weekly limit warning from claude terminal banner
    '94% of weekly limit reached — please conserve usage',
    // Credit exhaustion
    'Your credit balance has been exhausted. Please add more credits.',
    // MODEL_CAPACITY_EXHAUSTED from ACP (AcpClient.ts pattern)
    'MODEL_CAPACITY_EXHAUSTED: No capacity available for claude-opus-4',
  ];

  for (const sample of quotaSamples) {
    test(`quota: "${sample.slice(0, 60)}..."`, () => {
      assert.equal(classifyCarrierFailure(sample), 'quota');
    });
  }

  test('quota: Error object wrapping rate limit message', () => {
    assert.equal(classifyCarrierFailure(new Error('429 rate limit exceeded')), 'quota');
  });
});

describe('classifyCarrierFailure — structural class', () => {
  const structuralSamples = [
    // BgCarrier spawn failure (line 383)
    'claude --bg spawn failed: spawn claude ENOENT',
    // BgCarrier non-zero exit (line 390)
    'claude --bg exited code=127: /bin/sh: claude: command not found',
    // BgCarrier short id parse failure (line 394)
    'Could not parse short id from claude --bg stdout: Error: ...',
    // L0 compilation failure (line 202)
    'L0 compile failed for opus: SyntaxError: Unexpected token',
    // Permission denied
    'claude --bg spawn failed: spawn claude EACCES',
    // Transcript read failure in non-terminal state (line 560)
    'ClaudeBgCarrierService.invoke: transcript read failed for abc123: ENOENT',
  ];

  for (const sample of structuralSamples) {
    test(`structural: "${sample.slice(0, 60)}..."`, () => {
      assert.equal(classifyCarrierFailure(sample), 'structural');
    });
  }
});

describe('classifyCarrierFailure — transient class', () => {
  const transientSamples = [
    // Network error
    'ECONNRESET: connection reset by peer',
    // Timeout (line 695)
    'ClaudeBgCarrierService.invoke: timeout 1800000ms for abc123',
    // Abort (line 505)
    'ClaudeBgCarrierService.invoke: aborted for abc123',
    // API error from transcript (BgTranscriptEventConsumer:88)
    'API Error: temporary server error, please retry',
    // Generic unknown error
    'Something unexpected happened',
  ];

  for (const sample of transientSamples) {
    test(`transient: "${sample.slice(0, 60)}..."`, () => {
      assert.equal(classifyCarrierFailure(sample), 'transient');
    });
  }
});

// ─── Step 2: State machine transition tests (D2) ───

describe('CarrierHealthStore — state machine transitions', () => {
  /** @type {import('../dist/domains/cats/services/agents/providers/carrier-health.js').CarrierHealthStore} */
  let store;

  beforeEach(() => {
    store = new CarrierHealthStore(); // no Redis for unit tests
  });

  test('all tiers start healthy', () => {
    for (const tier of DEGRADATION_CHAIN) {
      assert.equal(store.isHealthy(tier), true);
    }
  });

  test('api_key is always healthy even after reportFailure', () => {
    store.reportFailure('api_key', 'quota');
    assert.equal(store.isHealthy('api_key'), true);
  });

  test('quota failure → degraded (sticky)', () => {
    store.reportFailure('bg_daemon', 'quota');
    assert.equal(store.isHealthy('bg_daemon'), false);
    const health = store.getHealth('bg_daemon');
    assert.equal(health.state, 'degraded');
    assert.equal(health.reason, 'quota');
  });

  test('structural failure → degraded (sticky)', () => {
    store.reportFailure('interactive_pty', 'structural');
    assert.equal(store.isHealthy('interactive_pty'), false);
    const health = store.getHealth('interactive_pty');
    assert.equal(health.state, 'degraded');
    assert.equal(health.reason, 'structural');
  });

  test('single transient failure does NOT degrade', () => {
    store.reportFailure('bg_daemon', 'transient');
    assert.equal(store.isHealthy('bg_daemon'), true);
  });

  test('3 consecutive transient failures → upgrade to structural degradation', () => {
    store.reportFailure('bg_daemon', 'transient');
    store.reportFailure('bg_daemon', 'transient');
    assert.equal(store.isHealthy('bg_daemon'), true, 'still healthy after 2');
    store.reportFailure('bg_daemon', 'transient');
    assert.equal(store.isHealthy('bg_daemon'), false, 'degraded after 3');
    const health = store.getHealth('bg_daemon');
    assert.equal(health.state, 'degraded');
    assert.equal(health.reason, 'structural'); // upgraded from transient
  });

  test('transient count resets after a non-transient failure', () => {
    store.reportFailure('bg_daemon', 'transient');
    store.reportFailure('bg_daemon', 'transient');
    // Now a quota failure
    store.reportFailure('bg_daemon', 'quota');
    // Recovery
    store.reportRecovery('bg_daemon');
    // Transient count should be reset — need 3 fresh transients
    store.reportFailure('bg_daemon', 'transient');
    assert.equal(store.isHealthy('bg_daemon'), true, 'fresh transient count after recovery');
  });

  test('reportRecovery → back to healthy', () => {
    store.reportFailure('bg_daemon', 'quota');
    assert.equal(store.isHealthy('bg_daemon'), false);
    store.reportRecovery('bg_daemon');
    assert.equal(store.isHealthy('bg_daemon'), true);
  });

  test('TTL expiry → isHealthy returns true (probe window)', () => {
    store.reportFailure('bg_daemon', 'structural');
    assert.equal(store.isHealthy('bg_daemon'), false);
    // Simulate TTL expiry by manipulating retryAfter
    const health = store.getHealth('bg_daemon');
    health.retryAfter = Date.now() - 1; // expired
    assert.equal(store.isHealthy('bg_daemon'), true, 'probe window after TTL');
  });

  test('quota TTL is longer than structural TTL', () => {
    const storeQ = new CarrierHealthStore();
    const storeS = new CarrierHealthStore();
    storeQ.reportFailure('bg_daemon', 'quota');
    storeS.reportFailure('interactive_pty', 'structural');
    const hQ = storeQ.getHealth('bg_daemon');
    const hS = storeS.getHealth('interactive_pty');
    assert.ok(hQ.retryAfter > hS.retryAfter, 'quota TTL > structural TTL');
  });
});

// ─── Step 3: Tier selection algorithm (D3) ───

describe('selectFirstHealthyTier — degradation chain walking', () => {
  /** @type {import('../dist/domains/cats/services/agents/providers/carrier-health.js').CarrierHealthStore} */
  let store;

  beforeEach(() => {
    store = new CarrierHealthStore();
  });

  test('all healthy → returns target tier', () => {
    assert.equal(selectFirstHealthyTier('bg_daemon', store), 'bg_daemon');
    assert.equal(selectFirstHealthyTier('interactive_pty', store), 'interactive_pty');
    assert.equal(selectFirstHealthyTier('print_sdk', store), 'print_sdk');
  });

  test('target degraded → falls to next healthy in chain', () => {
    store.reportFailure('bg_daemon', 'quota');
    assert.equal(selectFirstHealthyTier('bg_daemon', store), 'interactive_pty');
  });

  test('multiple degraded → skips to first healthy', () => {
    store.reportFailure('bg_daemon', 'structural');
    store.reportFailure('interactive_pty', 'structural');
    assert.equal(selectFirstHealthyTier('bg_daemon', store), 'print_sdk');
  });

  test('all degraded except api_key → returns api_key (last resort)', () => {
    store.reportFailure('bg_daemon', 'quota');
    store.reportFailure('interactive_pty', 'structural');
    store.reportFailure('print_sdk', 'structural');
    assert.equal(selectFirstHealthyTier('bg_daemon', store), 'api_key');
  });

  test('target is print_sdk, degraded → falls to api_key', () => {
    store.reportFailure('print_sdk', 'quota');
    assert.equal(selectFirstHealthyTier('print_sdk', store), 'api_key');
  });

  test('target is api_key → always returns api_key', () => {
    assert.equal(selectFirstHealthyTier('api_key', store), 'api_key');
  });

  test('unknown tier → returns as-is (no chain walking)', () => {
    assert.equal(selectFirstHealthyTier('unknown_tier', store), 'unknown_tier');
  });

  test('chain order is bg_daemon → interactive_pty → print_sdk → api_key', () => {
    assert.deepEqual(DEGRADATION_CHAIN, ['bg_daemon', 'interactive_pty', 'print_sdk', 'api_key']);
  });
});

// ─── Step 4: Integration — fallback event generation ───

describe('CarrierHealthStore — fallback event metadata', () => {
  test('after reportFailure, selectFirstHealthyTier routes to next tier', () => {
    const store = new CarrierHealthStore();
    store.reportFailure('bg_daemon', 'quota');
    // After reporting, selectFirstHealthyTier should return different tier
    const nextTier = selectFirstHealthyTier('bg_daemon', store);
    assert.notEqual(nextTier, 'bg_daemon');
    assert.equal(nextTier, 'interactive_pty');
  });
});

// ─── Step 5: Regression pin — no rollout config = current behavior ───

describe('regression: no health state = all healthy = current behavior', () => {
  test('fresh store with no failures → selectFirstHealthyTier returns target unchanged', () => {
    const store = new CarrierHealthStore();
    // This is the AC-B8 regression pin: without any health state,
    // the factory should behave exactly as today (env switch only)
    assert.equal(selectFirstHealthyTier('bg_daemon', store), 'bg_daemon');
    assert.equal(selectFirstHealthyTier('interactive_pty', store), 'interactive_pty');
    assert.equal(selectFirstHealthyTier('print_sdk', store), 'print_sdk');
    assert.equal(selectFirstHealthyTier('api_key', store), 'api_key');
  });
});
