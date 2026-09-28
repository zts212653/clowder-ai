/**
 * Unit tests for desktop/shutdown-plan.js.
 *
 * Concurrent teardown let the Web process keep routing requests into an API
 * that was already going away, and let Redis die at the same instant the API
 * was mid-write. These tests pin the dependency order that prevents both.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  SHUTDOWN_STAGES,
  TOTAL_SHUTDOWN_BUDGET_MS,
  UNKNOWN_STAGE_GRACE_MS,
  formatShutdownPlan,
  orderShutdownTargets,
  remainingBudget,
  stageTimeoutMs,
} = require('./shutdown-plan');

const names = (procNames) => orderShutdownTargets(procNames).map((target) => target.name);

describe('shutdown-plan: ordering', () => {
  it('stops web, then api, then redis regardless of input order', () => {
    for (const input of [
      ['api', 'redis', 'web'],
      ['redis', 'api', 'web'],
      ['web', 'api', 'redis'],
      ['redis', 'web', 'api'],
    ]) {
      assert.deepEqual(names(input), ['web', 'api', 'redis'], `input: ${input.join(',')}`);
    }
  });

  it('only includes processes that are actually running', () => {
    assert.deepEqual(names(['api']), ['api']);
    assert.deepEqual(names([]), []);
    assert.deepEqual(names(), []);
  });

  it('appends unknown services after the known ones', () => {
    const targets = orderShutdownTargets(['mcp-worker', 'api', 'redis', 'web']);

    assert.deepEqual(
      targets.map((target) => target.name),
      ['web', 'api', 'redis', 'mcp-worker'],
    );
    assert.equal(targets.at(-1).known, false);
    assert.equal(targets.at(-1).graceMs, UNKNOWN_STAGE_GRACE_MS);
  });

  it('deduplicates repeated names', () => {
    assert.deepEqual(names(['api', 'api', 'web']), ['web', 'api']);
    assert.deepEqual(names(['worker', 'worker']), ['worker']);
  });
});

describe('shutdown-plan: grace policy', () => {
  const byName = Object.fromEntries(SHUTDOWN_STAGES.map((stage) => [stage.name, stage]));

  it('never gives the Web stage more time than the API it feeds', () => {
    assert.ok(byName.web.graceMs <= byName.api.graceMs);
  });

  it('gives every stage a positive, finite grace period', () => {
    for (const target of orderShutdownTargets(['web', 'api', 'redis'])) {
      assert.ok(Number.isFinite(target.graceMs) && target.graceMs > 0, `${target.name} grace`);
    }
  });

  it('explains why each stage sits where it does', () => {
    assert.match(byName.web.reason, /new requests/);
    assert.match(byName.api.reason, /in-flight/);
    assert.match(byName.redis.reason, /after the API/);
  });
});

describe('shutdown-plan: logging', () => {
  it('renders the ordered plan with its grace values', () => {
    assert.equal(
      formatShutdownPlan(orderShutdownTargets(['api', 'redis', 'web'])),
      'web(2000ms) → api(5000ms) → redis(3000ms)',
    );
  });

  it('describes an empty plan', () => {
    assert.equal(formatShutdownPlan([]), 'nothing to stop');
    assert.equal(formatShutdownPlan(), 'nothing to stop');
  });
});

describe('shutdown-plan: total budget', () => {
  it('fits the whole teardown inside the installer quit window', () => {
    const total = SHUTDOWN_STAGES.reduce((sum, stage) => sum + stage.graceMs, 0);

    assert.ok(total <= TOTAL_SHUTDOWN_BUDGET_MS, `graces sum to ${total}ms`);
    // desktop/installer/cat-cafe.iss waits 15s for a coordinated quit before
    // it force-cleans, so the budget must stay below that.
    assert.ok(TOTAL_SHUTDOWN_BUDGET_MS < 15_000);
  });

  it('caps a stage by whatever budget is left', () => {
    const api = SHUTDOWN_STAGES.find((stage) => stage.name === 'api');

    assert.equal(stageTimeoutMs(api, 10_000), api.graceMs);
    assert.equal(stageTimeoutMs(api, 500), 500);
    assert.equal(stageTimeoutMs(api, 0), 0);
  });

  it('never reports a negative remaining budget', () => {
    assert.equal(remainingBudget(0, 4_000, 10_000), 6_000);
    assert.equal(remainingBudget(0, 10_000, 10_000), 0);
    assert.equal(remainingBudget(0, 99_999, 10_000), 0);
  });
});
