import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';
import { spawnCliInTmuxForTest } from './helpers/tmux-test-spawn.js';

for (const setupDelayMs of [0, 400]) {
  test(`AbortSignal unblocks FIFO read after ${setupDelayMs}ms setup delay`, { timeout: 15000 }, async (t) => {
    const gateway = new TmuxGateway();
    const worktreeId = `test-fifo-cancel-${randomUUID()}`;
    const abort = new AbortController();
    const create = gateway.createAgentPaneLease.bind(gateway);
    t.mock.method(gateway, 'createAgentPaneLease', async (...args) => {
      // Keep real creation; stretch setup past the old unconditional 200ms timer.
      await delay(setupDelayMs);
      return create(...args);
    });
    let abortedAt;
    let timer;
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo \'{"type":"fifo-ready"}\'; sleep 3600'],
        worktreeId,
        invocationId: randomUUID(),
        cwd: '/tmp',
        signal: AbortSignal.any([abort.signal, t.signal]),
        firstEventTimeoutMs: 60000,
        timeoutMs: 60000,
      },
      { tmuxGateway: gateway },
    );
    try {
      for await (const event of gen) {
        events.push(event);
        if (event.type === 'fifo-ready') {
          assert.equal(timer, undefined, 'arm cancellation exactly once after a real FIFO read');
          // Return from the loop body so the generator resumes its next read.
          // Pane-created metadata alone does not prove that the FIFO is open.
          timer = setTimeout(() => {
            abortedAt = performance.now();
            abort.abort();
          }, 200);
        }
      }
      assert.equal(events.filter((event) => event.type === 'fifo-ready').length, 1);
      assert.equal(abort.signal.aborted, true, 'must finish through cancellation');
      const elapsed = performance.now() - abortedAt;
      assert.ok(elapsed < 5000, `abort should unblock FIFO read within 5s, took ${elapsed}ms`);
      assert.equal(
        events.some((event) => event.__cliTimeout),
        false,
        'must not finish through a timeout',
      );
    } finally {
      clearTimeout(timer);
      abort.abort();
      await gateway.destroyServer(worktreeId);
    }
  });
}

test('setup cancellation after real lease acquisition rejects and cleans that lease', { timeout: 15000 }, async (t) => {
  const gateway = new TmuxGateway();
  const worktreeId = `test-setup-lease-cancel-${randomUUID()}`;
  const abort = new AbortController();
  const create = gateway.createAgentPaneLease.bind(gateway);
  const kill = gateway.killAgentPane.bind(gateway);
  let originalLease;
  let invocationDirectory;
  const cleanups = [];
  t.mock.method(gateway, 'createAgentPaneLease', async (wt, options) => {
    invocationDirectory = dirname(options.command.at(-1));
    originalLease = await create(wt, options);
    abort.abort();
    return originalLease;
  });
  t.mock.method(gateway, 'killAgentPane', (lease) => {
    const applied = kill(lease);
    cleanups.push({ lease, applied });
    return applied;
  });
  const events = [];
  try {
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'sleep 3600'],
        worktreeId,
        invocationId: randomUUID(),
        cwd: '/tmp',
        stdinInput: 'setup-private-input',
        signal: AbortSignal.any([abort.signal, t.signal]),
        firstEventTimeoutMs: 60000,
        timeoutMs: 60000,
      },
      { tmuxGateway: gateway },
    );
    await assert.rejects(
      async () => {
        for await (const event of gen) events.push(event);
      },
      { name: 'AbortError' },
    );
    assert.ok(originalLease, 'must reach real lease acquisition before abort');
    assert.deepEqual(events, [], 'setup cancellation must not yield a FIFO or pane event');
    assert.equal(cleanups.length, 1);
    assert.equal(cleanups[0].lease, originalLease, 'cleanup must consume the original lease object');
    assert.equal(cleanups[0].applied, true, 'exact lease termination must succeed');
    assert.deepEqual(await gateway.listPanes(worktreeId), [], 'setup cancellation must remove its pane');
    assert.equal(existsSync(invocationDirectory), false, 'setup must remove its private files');
  } finally {
    abort.abort();
    await gateway.destroyServer(worktreeId);
  }
});
