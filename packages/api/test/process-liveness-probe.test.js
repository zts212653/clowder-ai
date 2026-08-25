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

async function waitForState(probe, expectedState, { timeoutMs = 5_000, settleMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe.getState() === expectedState) return true;
    await new Promise((r) => setTimeout(r, settleMs));
  }
  return false;
}

function waitForMarker(stream, marker, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('close', onClose);
    };
    const onData = (chunk) => {
      buffered += chunk.toString();
      if (buffered.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`stream closed before marker: ${marker}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for marker: ${marker}`));
    }, timeoutMs);

    stream.on('data', onData);
    stream.once('close', onClose);
  });
}

test('new probe starts in active state', () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  assert.equal(probe.getState(), 'active');
  probe.stop();
});

test(
  'treats tiny CPU drift as idle-silent so stall auto-kill can fire',
  { skip: process.platform === 'win32' && 'suspected_stall suppressed without CPU sampling (#854)' },
  () => {
    const probe = new ProcessLivenessProbe(process.pid, {
      sampleIntervalMs: 1,
      softWarningMs: 100,
      stallWarningMs: 300,
      minCpuGrowthMs: 50,
    });

    probe.updateCpuSample(230);
    probe.lastActivityAt = Date.now() - 1_000;
    probe.updateCpuSample(270);

    const warnings = probe.drainWarnings();
    const stallWarning = warnings.find((w) => w.level === 'suspected_stall');
    assert.equal(probe.getState(), 'idle-silent');
    assert.equal(probe.shouldExtendTimeout(), false);
    assert.equal(stallWarning?.state, 'idle-silent');
    probe.stop();
  },
);

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
      sampleIntervalMs: 100,
      softWarningMs: 250,
      stallWarningMs: 2000,
    });
    probe.start();
    await new Promise((r) => setTimeout(r, 1200));
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
      sampleIntervalMs: 100,
      softWarningMs: 150,
      stallWarningMs: 500,
    });
    probe.start();
    await new Promise((r) => setTimeout(r, 1500));
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

test(
  'classifies as busy-silent when child process has growing CPU (Unix only)',
  { skip: process.platform === 'win32' && 'child CPU detection requires ps (Unix only)' },
  async () => {
    const { spawn } = await import('node:child_process');
    // Start with an idle parent and establish a flat CPU baseline before asking
    // it to spawn the busy child. Starting both processes before the probe made
    // the first sample compare cumulative startup CPU against zero: the test
    // could pass on parent startup alone, or miss the 50ms growth threshold when
    // the child was CPU-starved by the full gate.
    // LL-055: child carries its own deadline so it can't outlive the test
    // even if parent is SIGKILL'd before its SIGTERM handler fires.
    // macOS lacks PR_SET_PDEATHSIG, so a parent's death does not auto-kill the child;
    // without this self-suicide, every aborted test run leaks a CPU-burning orphan.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('child_process');
       let c = null;
       process.stdin.once('data', () => {
         c = spawn(process.execPath, ['-e', 'const end=Date.now()+12000;while(Date.now()<end){}'], { stdio: 'ignore' });
         process.stdout.write('child-started\\n');
       });
       process.on('SIGTERM', () => { c?.kill(); process.exit(0); });
       setInterval(() => {}, 60000);`,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );

    let probe = null;
    try {
      probe = new ProcessLivenessProbe(parent.pid, { sampleIntervalMs: 500 });
      probe.start();

      const reachedIdleSilent = await waitForState(probe, 'idle-silent');
      assert.ok(reachedIdleSilent, `idle parent should establish a flat baseline, got ${probe.getState()}`);

      const childStarted = waitForMarker(parent.stdout, 'child-started');
      parent.stdin.write('start-child\n');
      await childStarted;

      const reachedBusySilent = await waitForState(probe, 'busy-silent', { timeoutMs: 8_000 });
      const state = probe.getState();
      assert.ok(reachedBusySilent, `parent with busy child should reach busy-silent, got ${state}`);
      assert.equal(state, 'busy-silent', `parent with busy child should be busy-silent, got ${state}`);
    } finally {
      probe?.stop();
      parent.stdin.destroy();
      parent.kill('SIGTERM');
    }
  },
);

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

test(
  'on Windows, sampleOnce keeps cpuGrowing=false and exposes cpuSamplingAvailable (#854)',
  { skip: process.platform !== 'win32' && 'Windows platform guard — skipped on Unix' },
  async () => {
    // Without `ps`, CPU sampling is unavailable on Windows. cpuGrowing stays false
    // → state is idle-silent, shouldExtendTimeout() is false, and CLI_TIMEOUT_MS
    // (not bounded extension) is the binding constraint.
    // suspected_stall is gated on cpuSamplingAvailable so stall auto-kill won't fire.
    const probe = new ProcessLivenessProbe(process.pid, {
      sampleIntervalMs: 30,
      softWarningMs: 200,
      stallWarningMs: 500,
    });
    assert.equal(probe.cpuSamplingAvailable, false, 'cpuSamplingAvailable must be false on Windows');
    probe.start();
    // Wait past sampleIntervalMs so silence kicks in
    await new Promise((r) => setTimeout(r, 80));

    const state = probe.getState();
    assert.equal(state, 'idle-silent', 'Windows: cpuGrowing=false → idle-silent');
    assert.equal(probe.shouldExtendTimeout(), false, 'idle-silent does not extend timeout');
    probe.stop();
  },
);

test(
  'on Windows, alive_but_silent fires but suspected_stall is suppressed (#854)',
  { skip: process.platform !== 'win32' && 'Windows platform guard — skipped on Unix' },
  async () => {
    // Without CPU evidence, suspected_stall would be a false positive — suppressed
    // via cpuSamplingAvailable guard. alive_but_silent (informational) still fires.
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
      !warnings.some((w) => w.level === 'suspected_stall'),
      'must NOT emit suspected_stall without CPU sampling (#854)',
    );
    probe.stop();
  },
);
