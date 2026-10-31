import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';
import { createPaneCreationRecord } from '../dist/domains/terminal/tmux-pane-creation-record.js';

test('unclaimed liveness covers inactive windows in every session and excludes dead panes', async () => {
  const gateway = new TmuxGateway();
  const worktreeId = `test-unclaimed-${randomUUID()}`;
  const socket = gateway.socketName(worktreeId);
  const token = randomUUID();
  const record = createPaneCreationRecord(gateway.tmuxBin, socket, worktreeId, token);
  const tmux = (...args) => execFileSync(gateway.tmuxBin, ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const targets = [];
  let outcome;
  let settled = false;
  try {
    // Both sessions have an unrelated selected window. The matching panes are
    // in inactive windows, so a current-session/current-window shortcut fails.
    for (const session of ['one', 'two']) {
      tmux('-f', '/dev/null', 'new-session', '-d', '-s', session, '/bin/sleep', '30');
      targets.push(
        tmux(
          'new-window',
          '-d',
          '-t',
          `${session}:`,
          '-P',
          '-F',
          '#{pane_id}',
          '/usr/bin/env',
          `CAT_CAFE_PANE_TOKEN=${token}`,
          '/bin/sleep',
          '30',
        ),
      );
    }
    const unrelated = tmux('list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_dead}')
      .split('\n')
      .filter((row) => !targets.some((pane) => row.startsWith(`${pane}|`)));
    // Pre-claim launchers observe a closed gate before this read-only wait.
    assert.equal(record.finish(false), 'empty');
    outcome = record.awaitUnclaimedExit().finally(() => {
      settled = true;
    });
    await delay(150);
    assert.equal(settled, false, 'live matching panes outside the current window must hold the wait');
    for (const [index, pane] of targets.entries()) {
      tmux('set-option', '-w', '-t', pane, 'remain-on-exit', 'on');
      tmux('send-keys', '-t', pane, 'C-c');
      const deadline = Date.now() + 2000;
      while (tmux('display-message', '-p', '-t', pane, '#{pane_dead}') !== '1' && Date.now() < deadline)
        await delay(10);
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_dead}'), '1');
      if (index === 0) {
        await delay(150);
        assert.equal(settled, false, 'a second session still has a live matching pane');
      }
    }
    await outcome;
    assert.deepEqual(
      tmux('list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_dead}')
        .split('\n')
        .filter((row) => !targets.some((pane) => row.startsWith(`${pane}|`))),
      unrelated,
    );
    assert.equal(
      targets.every((pane) => tmux('display-message', '-p', '-t', pane, '#{pane_dead}') === '1'),
      true,
      'the liveness observer must leave dead panes intact',
    );
  } finally {
    await gateway.destroyServer(worktreeId);
    await outcome;
  }
});
