/**
 * ProcessLivenessProbe Tests — F118 Phase B
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ProcessLivenessProbe } = await import('../dist/utils/ProcessLivenessProbe.js');

async function waitForBusySilent(probe, { timeoutMs = 3_000, burnMs = 180, settleMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const burnUntil = Date.now() + burnMs;
    while (Date.now() < burnUntil) {
      Math.random() * Math.random();
    }
    await new Promise((r) => setTimeout(r, settleMs));
    if (probe.getState() === 'busy-silent') {
      return true;
    }
  }
  return false;
}

test('new probe starts in active state', () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  assert.equal(probe.getState(), 'active');
  probe.stop();
});

test('detects dead process (PID does not exist)', async () => {
  const probe = new ProcessLivenessProbe(99999, { sampleIntervalMs: 50 });
  probe.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(probe.getState(), 'dead');
  probe.stop();
});

test('classifies as busy-silent when CPU grows but no output', async () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  probe.start();
  const reachedBusySilent = await waitForBusySilent(probe);
  const state = probe.getState();
  assert.ok(reachedBusySilent, `expected busy-silent within timeout, got ${state}`);
  assert.equal(state, 'busy-silent');
  probe.stop();
});

test('generates alive_but_silent warning at soft threshold', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 50,
    stallWarningMs: 200,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 100));
  const warnings = probe.drainWarnings();
  assert.ok(warnings.some((w) => w.level === 'alive_but_silent'));
  probe.stop();
});

test('generates suspected_stall warning at stall threshold', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 30,
    stallWarningMs: 80,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 150));
  const warnings = probe.drainWarnings();
  assert.ok(warnings.some((w) => w.level === 'suspected_stall'));
  probe.stop();
});

test('notifyActivity resets silence timer and clears warning state', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 50,
    stallWarningMs: 200,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 30));
  probe.notifyActivity();
  await new Promise((r) => setTimeout(r, 30));
  const warnings = probe.drainWarnings();
  const softWarnings = warnings.filter((w) => w.level === 'alive_but_silent');
  assert.equal(softWarnings.length, 0);
  probe.stop();
});

test('shouldExtendTimeout returns true when busy-silent', async () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  probe.start();
  const reachedBusySilent = await waitForBusySilent(probe);
  assert.ok(reachedBusySilent, `expected busy-silent within timeout, got ${probe.getState()}`);
  assert.equal(probe.shouldExtendTimeout(), true);
  probe.stop();
});

test('isHardCapExceeded returns true when elapsed >= factor * timeout', () => {
  const probe = new ProcessLivenessProbe(process.pid, { boundedExtensionFactor: 2 });
  assert.equal(probe.isHardCapExceeded(500, 300), false);
  assert.equal(probe.isHardCapExceeded(600, 300), true, 'exactly 2x should be exceeded');
  assert.equal(probe.isHardCapExceeded(601, 300), true);
  probe.stop();
});

const { parseCpuTime } = await import('../dist/utils/ProcessLivenessProbe.js');

test('parseCpuTime handles mm:ss.SS format', () => {
  assert.equal(parseCpuTime('1:30.50'), (1 * 60 + 30.5) * 1000);
  assert.equal(parseCpuTime('0:00.00'), 0);
});

test('parseCpuTime handles h:mm:ss format', () => {
  assert.equal(parseCpuTime('1:02:03'), (1 * 3600 + 2 * 60 + 3) * 1000);
});

test('parseCpuTime handles empty/invalid input', () => {
  assert.equal(parseCpuTime(''), 0);
  assert.equal(parseCpuTime('  '), 0);
});
