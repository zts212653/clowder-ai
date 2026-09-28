import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnCliInTmux } from '../dist/domains/terminal/tmux-agent-spawner.js';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

async function waitForFile(path) {
  const deadline = Date.now() + 6000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(path), 'the real agent command must have started');
}

async function startAgent(gateway, worktreeId, dir, name) {
  const ready = join(dir, `${name}-ready`);
  const release = join(dir, `${name}-release`);
  const abort = new AbortController();
  const iterator = spawnCliInTmux(
    {
      command: '/bin/sh',
      args: [
        '-c',
        `touch '${ready}'; printf 'ready\\n'; while [ ! -f '${release}' ]; do sleep .05; done; printf '${name}-done\\n'`,
      ],
      env: {},
      outputMode: 'plainText',
      worktreeId,
      invocationId: `${name}-${randomUUID()}`,
      cwd: dir,
      firstEventTimeoutMs: 10000,
      timeoutMs: 10000,
      signal: abort.signal,
    },
    { tmuxGateway: gateway },
  );
  const first = await iterator.next();
  assert.equal(first.value.__tmuxPaneCreated, true);
  const events = [];
  const finished = (async () => {
    for await (const event of iterator) events.push(event);
    return events;
  })();
  // Observe failures even if the later lifetime assertion fails first.
  void finished.catch(() => {});
  await waitForFile(ready);
  return { paneId: first.value.paneId, abort, finished, release };
}

function paneState(gateway, worktreeId, paneId) {
  try {
    const rows = execFileSync(
      gateway.tmuxBin,
      ['-L', gateway.socketName(worktreeId), 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_dead}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n');
    return rows.find((line) => line.startsWith(`${paneId} `))?.slice(paneId.length + 1) ?? null;
  } catch {
    return null;
  }
}

test('old invocation cleanup cannot kill a successor on a recreated server', { timeout: 20000 }, async () => {
  const gateway = new TmuxGateway();
  const worktreeId = `test-pane-lifetime-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'catcafe-pane-lifetime-'));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let first;
  let successor;
  let releaseGrace;
  try {
    first = await startAgent(gateway, worktreeId, dir, 'A');
    const originalState = paneState(gateway, worktreeId, first.paneId);
    assert.match(originalState, /^\d+ 0$/, 'A must be alive before its delayed cleanup starts');

    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms !== 3000 || releaseGrace) return originalSetTimeout(callback, ms, ...args);
      const handle = originalSetTimeout(callback, 15000, ...args);
      releaseGrace = () => {
        originalClearTimeout(handle);
        callback(...args);
      };
      return handle;
    };
    first.abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.setTimeout = originalSetTimeout;
    assert.equal(typeof releaseGrace, 'function', 'A must actually enter the cleanup grace window');

    await gateway.destroyServer(worktreeId);
    successor = await startAgent(gateway, worktreeId, dir, 'B');
    assert.equal(successor.paneId, first.paneId, 'the fixture must reproduce pane-ID reuse');
    const successorState = paneState(gateway, worktreeId, successor.paneId);
    assert.match(successorState, /^\d+ 0$/, 'B must actually start before releasing old cleanup');
    assert.notEqual(successorState, originalState, 'B must have a distinct process identity');

    releaseGrace();
    releaseGrace = undefined;
    await first.finished;
    assert.equal(
      paneState(gateway, worktreeId, successor.paneId),
      successorState,
      'A cleanup must leave the live successor untouched',
    );
    writeFileSync(successor.release, '');
    const events = await successor.finished;
    assert.match(events.find((event) => event.__cliPlainText)?.stdout ?? '', /B-done/);
    assert.equal(
      events.some((event) => event.__cliTimeout || event.__cliError),
      false,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    releaseGrace?.();
    first?.abort.abort();
    successor?.abort.abort();
    await gateway.destroyServer(worktreeId);
    await Promise.allSettled([first?.finished, successor?.finished]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the identity check and mutation have no intervening client boundary', { timeout: 12000 }, async () => {
  const gateway = new TmuxGateway();
  const wt = `test-lease-atomic-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'catcafe-lease-atomic-'));
  const proxy = join(dir, 'tmux-proxy.cjs');
  const config = {
    bin: gateway.tmuxBin,
    socket: gateway.socketName(wt),
    armed: join(dir, 'armed'),
    ready: join(dir, 'ready'),
    release: join(dir, 'release'),
    done: join(dir, 'done'),
    witness: join(dir, 'witness'),
  };
  try {
    const lease = await gateway.createAgentPaneLease(wt, { command: ['/bin/sh', '-c', 'sleep 30'], cwd: dir });
    assert.match(paneState(gateway, wt, lease.paneId), /^\d+ 0$/);
    writeFileSync(join(dir, 'control.json'), JSON.stringify(config));
    const fixture = readFileSync(new URL('./fixtures/tmux-lifetime-proxy.cjs', import.meta.url), 'utf8');
    writeFileSync(proxy, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
    gateway.tmuxBin = proxy;
    writeFileSync(config.armed, '');
    assert.equal(gateway.interruptAgentPane(lease), false, 'the successor must not inherit old interrupt authority');
    assert.ok(existsSync(config.witness), 'the fixture must actually replace the server at the client boundary');
    const successorState = paneState(gateway, wt, lease.paneId);
    assert.match(successorState, /^\d+ 0$/);
    assert.notEqual(successorState.split(' ')[0], lease.panePid);
    assert.equal(gateway.killAgentPane(lease), false);
    assert.equal(paneState(gateway, wt, lease.paneId), successorState);
    writeFileSync(config.release, '');
    await waitForFile(config.done);
  } finally {
    await gateway.destroyServer(wt);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'a matching lease still controls its pane after a display rename and leaves the active sibling intact',
  { timeout: 10000 },
  async () => {
    const gateway = new TmuxGateway();
    const wt = `test-pane-match-${randomUUID()}`;
    try {
      const options = { cwd: '/tmp', command: ['/bin/sh', '-c', 'trap "" INT; while true; do sleep 1; done'] };
      const original = await gateway.createAgentPaneLease(wt, options);
      const sibling = await gateway.createAgentPaneLease(wt, options);
      assert.equal(Object.isFrozen(original), true);
      assert.equal(
        gateway.killAgentPane({ ...original, token: randomUUID() }),
        false,
        'a matching address and PID cannot substitute for the creation token',
      );
      execFileSync(gateway.tmuxBin, [
        '-L',
        gateway.socketName(wt),
        'rename-window',
        '-t',
        original.paneId,
        'human-label',
      ]);
      assert.equal(
        gateway.interruptAgentPane(original),
        true,
        'changing a display name must not revoke the creation identity',
      );
      assert.equal(gateway.killAgentPane(original), true, 'the matching lease must authorize cleanup');
      assert.equal(paneState(gateway, wt, original.paneId), null, 'the matching pane must be terminated');
      assert.match(paneState(gateway, wt, sibling.paneId), /^\d+ 0$/, 'the active sibling must survive');
    } finally {
      await gateway.destroyServer(wt);
    }
  },
);
