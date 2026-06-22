/**
 * F167 Phase O PR-O3: gate-keeping guard policy patch tests.
 *
 * Replaces blanket block for issue_tracking / hold_ball with structured allow:
 *   - PR tracking → always blocked (unchanged)
 *   - Keeper-owned issue tracking → allowed
 *   - Distributed issue tracking → blocked
 *   - Short-SLA no-callback hold → allowed
 *   - Event-backed hold → blocked
 *   - Long/unbounded wait → blocked (push to sweep)
 *
 * These test the guard function directly (unit-level) to avoid coupling
 * to route schema during the RED phase.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/** Lazy import — dist must be built. */
async function importGuard() {
  return import('../dist/routes/gate-keeping-guard.js');
}

/** Stub thread store that returns a gate-keeping thread. */
function gateKeepingThreadStore(threadId) {
  return {
    async get(id) {
      if (id === threadId) return { id, threadKind: 'gate-keeping' };
      return { id, threadKind: undefined };
    },
  };
}

/** No-op metric counter. */
const noopMetric = { add() {} };

describe('F167 PR-O3: gate-keeping guard policy patch', () => {
  // ── register_pr_tracking: always blocked (regression) ─────────
  test('PR tracking stays blocked in gate-keeping thread (regression)', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t1'),
      threadId: 't1',
      tool: 'register_pr_tracking',
      metric: noopMetric,
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockedResponse?.tool, 'register_pr_tracking');
  });

  // ── register_issue_tracking: keeper-owned → allowed ───────────
  test('keeper-owned issue tracking allowed in gate-keeping thread', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t2'),
      threadId: 't2',
      tool: 'register_issue_tracking',
      metric: noopMetric,
      policyContext: { issueOwnership: 'keeper' },
    });
    assert.equal(result.outcome, 'allowed_by_policy');
    assert.equal(result.blockedResponse, undefined);
  });

  // ── register_issue_tracking: distributed → blocked ────────────
  test('distributed issue tracking blocked in gate-keeping thread', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t3'),
      threadId: 't3',
      tool: 'register_issue_tracking',
      metric: noopMetric,
      policyContext: { issueOwnership: 'distributed' },
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockedResponse?.tool, 'register_issue_tracking');
  });

  // ── register_issue_tracking: no ownership hint → blocked (default safe) ──
  test('issue tracking without ownership hint blocked in gate-keeping thread (default safe)', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t4'),
      threadId: 't4',
      tool: 'register_issue_tracking',
      metric: noopMetric,
      // no policyContext → default behavior = blocked
    });
    assert.equal(result.outcome, 'blocked');
  });

  // ── hold_ball: short SLA + no callback + grounded → allowed ──────────────
  test('short-SLA no-callback hold allowed in gate-keeping thread', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t5'),
      threadId: 't5',
      tool: 'hold_ball',
      metric: noopMetric,
      // PR-O4: hasWaitSourceRef required for grounded hold
      policyContext: { wakeAfterMs: 120_000, hasEventCallback: false, hasWaitSourceRef: true },
    });
    assert.equal(result.outcome, 'allowed_by_policy');
    assert.equal(result.blockedResponse, undefined);
  });

  // ── hold_ball: event-backed → blocked ─────────────────────────
  test('event-backed hold blocked in gate-keeping thread', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t6'),
      threadId: 't6',
      tool: 'hold_ball',
      metric: noopMetric,
      policyContext: { wakeAfterMs: 120_000, hasEventCallback: true },
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockedResponse?.tool, 'hold_ball');
  });

  // ── hold_ball: long/unbounded wait → blocked (sweep) ──────────
  test('long-SLA hold blocked in gate-keeping thread (push to sweep)', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t7'),
      threadId: 't7',
      tool: 'hold_ball',
      metric: noopMetric,
      policyContext: { wakeAfterMs: 1_800_000, hasEventCallback: false },
    });
    assert.equal(result.outcome, 'blocked');
  });

  // ── hold_ball: boundary — exactly at threshold → allowed ──────
  test('hold at SHORT_SLA boundary → allowed', async () => {
    const { checkGateKeepingGuard, SHORT_SLA_THRESHOLD_MS } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t8'),
      threadId: 't8',
      tool: 'hold_ball',
      metric: noopMetric,
      // PR-O4: hasWaitSourceRef required for grounded hold
      policyContext: { wakeAfterMs: SHORT_SLA_THRESHOLD_MS, hasEventCallback: false, hasWaitSourceRef: true },
    });
    assert.equal(result.outcome, 'allowed_by_policy');
  });

  // ── hold_ball: boundary — 1ms over threshold → blocked ────────
  test('hold 1ms over SHORT_SLA threshold → blocked', async () => {
    const { checkGateKeepingGuard, SHORT_SLA_THRESHOLD_MS } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t9'),
      threadId: 't9',
      tool: 'hold_ball',
      metric: noopMetric,
      policyContext: { wakeAfterMs: SHORT_SLA_THRESHOLD_MS + 1, hasEventCallback: false },
    });
    assert.equal(result.outcome, 'blocked');
  });

  // ── hold_ball: no policyContext → blocked (default safe) ──────
  test('hold without policyContext blocked in gate-keeping thread (default safe)', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const result = await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('t10'),
      threadId: 't10',
      tool: 'hold_ball',
      metric: noopMetric,
      // no policyContext → default = blocked (backward compat)
    });
    assert.equal(result.outcome, 'blocked');
  });

  // ── Metric emission for allowed_by_policy ─────────────────────
  test('allowed_by_policy emits metric with correct attributes', async () => {
    const { checkGateKeepingGuard } = await importGuard();
    const recorded = [];
    const metric = {
      add(val, attrs) {
        recorded.push({ val, attrs });
      },
    };

    await checkGateKeepingGuard({
      threadStore: gateKeepingThreadStore('tm'),
      threadId: 'tm',
      tool: 'hold_ball',
      metric,
      // PR-O4: hasWaitSourceRef required for grounded hold
      policyContext: { wakeAfterMs: 60_000, hasEventCallback: false, hasWaitSourceRef: true },
    });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].attrs['callback.tool'], 'hold_ball');
    assert.equal(recorded[0].attrs.status, 'allowed_by_policy');
  });
});
