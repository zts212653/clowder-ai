/**
 * ProcessLivenessProbe Tests — F118 Phase B
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ProcessLivenessProbe } = await import('../dist/utils/ProcessLivenessProbe.js');
const IS_WINDOWS = process.platform === 'win32';

async function waitForBusySilent(
  probe,
  { timeoutMs = IS_WINDOWS ? 8_000 : 3_000, burnMs = IS_WINDOWS ? 260 : 180, settleMs = IS_WINDOWS ? 70 : 40 } = {},
) {
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

async function waitForWarning(
  probe,
  level,
  { timeoutMs = IS_WINDOWS ? 5_000 : 1_500, pollMs = IS_WINDOWS ? 80 : 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const warnings = probe.drainWarnings();
    if (warnings.some((w) => w.level === level)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
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

test(
  'classifies as busy-silent when CPU grows but no output (Unix only)',
  { skip: process.platform === 'win32' && 'busy-silent requires ps CPU sampling (Unix only)' },
  async () => {
    const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
    probe.start();
    const reachedBusySilent = await waitForBusySilent(probe);
    const state = probe.getState();
    assert.ok(reachedBusySilent, `expected busy-silent within timeout, got ${state}`);
    assert.equal(state, 'busy-silent');
    probe.stop();
  },
);

test('generates alive_but_silent warning at soft threshold', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: IS_WINDOWS ? 120 : 20,
    softWarningMs: IS_WINDOWS ? 220 : 50,
    stallWarningMs: IS_WINDOWS ? 1_000 : 200,
  });
  probe.start();
  const hasWarning = await waitForWarning(probe, 'alive_but_silent');
  assert.ok(hasWarning, 'expected alive_but_silent warning within timeout');
  probe.stop();
});

test('generates suspected_stall warning at stall threshold', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: IS_WINDOWS ? 120 : 20,
    softWarningMs: IS_WINDOWS ? 200 : 30,
    stallWarningMs: IS_WINDOWS ? 500 : 80,
  });
  probe.start();
  const hasWarning = await waitForWarning(probe, 'suspected_stall', {
    timeoutMs: IS_WINDOWS ? 8_000 : 2_000,
  });
  assert.ok(hasWarning, 'expected suspected_stall warning within timeout');
  probe.stop();
});

test('notifyActivity resets silence timer and clears warning state', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: IS_WINDOWS ? 120 : 20,
    softWarningMs: IS_WINDOWS ? 250 : 50,
    stallWarningMs: IS_WINDOWS ? 900 : 200,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, IS_WINDOWS ? 80 : 30));
  probe.notifyActivity();
  await new Promise((r) => setTimeout(r, IS_WINDOWS ? 120 : 30));
  const warnings = probe.drainWarnings();
  const softWarnings = warnings.filter((w) => w.level === 'alive_but_silent');
  assert.equal(softWarnings.length, 0);
  probe.stop();
});

test(
  'shouldExtendTimeout returns true when busy-silent (Unix only)',
  { skip: process.platform === 'win32' && 'busy-silent requires ps CPU sampling (Unix only)' },
  async () => {
    const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
    probe.start();
    const reachedBusySilent = await waitForBusySilent(probe);
    assert.ok(reachedBusySilent, `expected busy-silent within timeout, got ${probe.getState()}`);
    assert.equal(probe.shouldExtendTimeout(), true);
    probe.stop();
  },
);

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

// --- Windows platform guard tests ---

test('on Windows, sampleOnce sets cpuGrowing=false (conservative idle-silent)', async () => {
  // This test runs on Windows where the platform guard is active.
  // The probe should classify silent processes as idle-silent (not busy-silent),
  // preserving stall detection semantics.
  if (process.platform !== 'win32') {
    // On non-Windows, the Unix ps-based path runs instead — skip.
    return;
  }

  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 30,
    softWarningMs: 200,
    stallWarningMs: 500,
  });
  probe.start();
  // Wait past sampleIntervalMs so silence kicks in
  await new Promise((r) => setTimeout(r, 80));

  const state = probe.getState();
  // On Windows, with cpuGrowing=false, the state should be idle-silent (not busy-silent)
  assert.equal(state, 'idle-silent', 'Windows guard must set cpuGrowing=false → idle-silent');
  assert.equal(probe.shouldExtendTimeout(), false, 'idle-silent must NOT extend timeout');
  probe.stop();
});

test('on Windows, silence warnings still fire correctly', async () => {
  if (process.platform !== 'win32') {
    return;
  }

  // Keep stall threshold high so this test deterministically observes
  // alive_but_silent first on slower Windows runners.
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 120,
    softWarningMs: 600,
    stallWarningMs: 20_000,
  });
  probe.start();
  const hasSoftWarning = await waitForWarning(probe, 'alive_but_silent', {
    timeoutMs: 20_000,
    pollMs: 120,
  });
  assert.ok(hasSoftWarning, 'should emit alive_but_silent warning on Windows');
  probe.stop();
});
