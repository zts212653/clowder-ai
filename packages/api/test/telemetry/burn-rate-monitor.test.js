/**
 * F153 Phase E L3: BurnRateMonitor tests.
 *
 * Covers:
 * - Threshold evaluation (error rate, p95 latency, active invocations)
 * - Debouncing (consecutive breaches before alert)
 * - Auto-clear on recovery
 * - No alert when metrics are healthy
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { BurnRateMonitor } = await import('../../dist/infrastructure/telemetry/burn-rate-monitor.js');

function makeMetricsText({ errorRate = 0, p95 = null, activeInvocations = null } = {}) {
  const ok = errorRate < 1 ? Math.round((1 - errorRate) * 100) : 0;
  const error = Math.round(errorRate * 100);
  const lines = [
    `cat_cafe_invocation_completed{status="ok"} ${ok}`,
    `cat_cafe_invocation_completed{status="error"} ${error}`,
  ];
  if (p95 !== null) {
    lines.push(`cat_cafe_cat_response_duration{quantile="0.95"} ${p95}`);
  }
  if (activeInvocations !== null) {
    lines.push(`cat_cafe_active_invocations ${activeInvocations}`);
  }
  return lines.join('\n');
}

test('BurnRateMonitor: no alert when metrics are healthy', async () => {
  let alertFired = false;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ errorRate: 0.1 }),
    onAlert: () => {
      alertFired = true;
    },
    onClear: () => {},
    debounceCount: 1,
  });

  await monitor.check();
  assert.equal(alertFired, false);
  assert.equal(monitor.isAlertActive(), false);
});

test('BurnRateMonitor: fires alert after debounce count', async () => {
  let alertAlerts = null;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ errorRate: 0.5 }),
    onAlert: (alerts) => {
      alertAlerts = alerts;
    },
    onClear: () => {},
    debounceCount: 3,
    thresholds: { errorRate: 0.3, p95LatencyS: 120, activeInvocations: 50 },
  });

  await monitor.check();
  assert.equal(alertAlerts, null, 'Should not fire after 1 breach');

  await monitor.check();
  assert.equal(alertAlerts, null, 'Should not fire after 2 breaches');

  await monitor.check();
  assert.ok(alertAlerts, 'Should fire after 3 consecutive breaches');
  assert.ok(alertAlerts.some((a) => a.metric === 'error_rate'));
  assert.equal(monitor.isAlertActive(), true);
});

test('BurnRateMonitor: auto-clears on recovery', async () => {
  let cleared = false;
  let breaching = true;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ errorRate: breaching ? 0.5 : 0.1 }),
    onAlert: () => {},
    onClear: () => {
      cleared = true;
    },
    debounceCount: 1,
    thresholds: { errorRate: 0.3, p95LatencyS: 120, activeInvocations: 50 },
  });

  await monitor.check();
  assert.equal(monitor.isAlertActive(), true);

  breaching = false;
  await monitor.check();
  assert.equal(cleared, true);
  assert.equal(monitor.isAlertActive(), false);
});

test('BurnRateMonitor: consecutive count resets on recovery', async () => {
  let alertFired = false;
  let healthy = false;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ errorRate: healthy ? 0.1 : 0.5 }),
    onAlert: () => {
      alertFired = true;
    },
    onClear: () => {},
    debounceCount: 3,
    thresholds: { errorRate: 0.3, p95LatencyS: 120, activeInvocations: 50 },
  });

  await monitor.check(); // breach 1
  await monitor.check(); // breach 2

  healthy = true;
  await monitor.check(); // recovery — resets count

  healthy = false;
  await monitor.check(); // breach 1 again
  await monitor.check(); // breach 2
  assert.equal(alertFired, false, 'Reset should prevent premature alert');

  await monitor.check(); // breach 3 — NOW it fires
  assert.equal(alertFired, true);
});

test('BurnRateMonitor: detects active invocations breach', async () => {
  let alertAlerts = null;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ activeInvocations: 100 }),
    onAlert: (alerts) => {
      alertAlerts = alerts;
    },
    onClear: () => {},
    debounceCount: 1,
    thresholds: { errorRate: 0.3, p95LatencyS: 120, activeInvocations: 50 },
  });

  await monitor.check();
  assert.ok(alertAlerts);
  assert.ok(alertAlerts.some((a) => a.metric === 'active_invocations'));
});

test('BurnRateMonitor: detects p95 latency breach', async () => {
  let alertAlerts = null;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ p95: 200 }),
    onAlert: (alerts) => {
      alertAlerts = alerts;
    },
    onClear: () => {},
    debounceCount: 1,
    thresholds: { errorRate: 0.3, p95LatencyS: 120, activeInvocations: 50 },
  });

  await monitor.check();
  assert.ok(alertAlerts);
  assert.ok(alertAlerts.some((a) => a.metric === 'p95_latency_s'));
});

test('BurnRateMonitor: handles getMetricsText failure gracefully', async () => {
  let alertFired = false;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => {
      throw new Error('read failed');
    },
    onAlert: () => {
      alertFired = true;
    },
    onClear: () => {},
    debounceCount: 1,
  });

  await monitor.check();
  assert.equal(alertFired, false);
  assert.equal(monitor.isAlertActive(), false);
});

test('BurnRateMonitor: start/stop lifecycle', () => {
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => '',
    onAlert: () => {},
    onClear: () => {},
    intervalMs: 100_000,
  });

  monitor.start();
  monitor.start(); // idempotent
  monitor.stop();
  monitor.stop(); // idempotent
});

test('BurnRateMonitor: does not re-fire alert while already active', async () => {
  let alertCount = 0;
  const monitor = new BurnRateMonitor({
    getMetricsText: async () => makeMetricsText({ errorRate: 0.5 }),
    onAlert: () => {
      alertCount++;
    },
    onClear: () => {},
    debounceCount: 1,
    thresholds: { errorRate: 0.3, p95LatencyS: 120, activeInvocations: 50 },
  });

  await monitor.check();
  await monitor.check();
  await monitor.check();
  assert.equal(alertCount, 1, 'Alert should only fire once until cleared');
});
