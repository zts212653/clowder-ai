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

test(
  'generates alive_but_silent warning at soft threshold (Unix only)',
  { skip: process.platform === 'win32' && 'silence warnings require Windows platform guard (PR #250)' },
  async () => {
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
  },
);

test(
  'generates suspected_stall warning at stall threshold (Unix only)',
  { skip: process.platform === 'win32' && 'silence warnings require Windows platform guard (PR #250)' },
  async () => {
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
  },
);

test('notifyActivity resets silence timer and clears warning state', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 150,
    stallWarningMs: 500,
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

  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 50,
    stallWarningMs: 150,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 200));

  const warnings = probe.drainWarnings();
  assert.ok(
    warnings.some((w) => w.level === 'alive_but_silent'),
    'should emit alive_but_silent warning on Windows',
  );
  assert.ok(
    warnings.some((w) => w.level === 'suspected_stall'),
    'should emit suspected_stall warning on Windows',
  );
  probe.stop();
});
