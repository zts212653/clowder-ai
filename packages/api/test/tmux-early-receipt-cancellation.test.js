import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check, message) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), message);
}
function rows(bin, socket) {
  try {
    return execFileSync(
      bin,
      ['-L', socket, 'list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_start_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n');
  } catch {
    return [];
  }
}

for (const existing of [false, true]) {
  test(
    `${existing ? 'existing' : 'fresh'} early receipt cannot bypass waiting for a pre-claim successor`,
    { timeout: 15000 },
    async () => {
      const gateway = new TmuxGateway();
      const bin = gateway.tmuxBin;
      const wt = `test-early-receipt-${randomUUID()}`;
      const socket = gateway.socketName(wt);
      const dir = mkdtempSync(join(tmpdir(), 'catcafe-early-receipt-'));
      const barrier = join(dir, 'barrier');
      const release = join(dir, 'release');
      const witnessPath = join(dir, 'witness');
      const clientClosed = join(dir, 'native-client-closed');
      const started = join(dir, 'agent-started');
      const abort = new AbortController();
      let outcome;
      let witness;
      let settled = false;
      try {
        if (existing) await gateway.createAgentPaneLease(wt, { command: ['/bin/sleep', '30'], cwd: dir });
        const siblings = rows(bin, socket);
        writeFileSync(
          join(dir, 'control.json'),
          JSON.stringify({ bin, socket, barrier, release, clientClosed, witness: witnessPath }),
        );
        const proxy = join(dir, 'tmux.cjs');
        writeFileSync(
          proxy,
          `#!${process.execPath}\n${readFileSync(new URL('./fixtures/tmux-early-receipt-proxy.cjs', import.meta.url), 'utf8')}`,
          { mode: 0o700 },
        );
        gateway.tmuxBin = proxy;
        outcome = gateway
          .createAgentPaneLease(wt, {
            command: ['/bin/sh', '-c', `echo $$ > '${started}'; exec /bin/sleep 30`],
            cwd: dir,
            signal: abort.signal,
          })
          .then(
            (lease) => ({ lease }),
            (error) => ({ error }),
          )
          .then((result) => {
            settled = true;
            return result;
          });
        await until(
          () => existsSync(witnessPath) && existsSync(clientClosed),
          'complete native receipt must be streamed before abort',
        );
        witness = JSON.parse(readFileSync(witnessPath, 'utf8'));
        assert.equal(witness.receipt, `${witness.paneId} ${witness.panePid}\n`);
        await until(() => existsSync(barrier), 'original launcher must stop before publishing');
        assert.equal(readFileSync(barrier, 'utf8'), `${witness.paneId}.${witness.panePid}`);
        assert.throws(() => readlinkSync(join(witness.gate, 'claim')), { code: 'ENOENT' });
        const original = rows(bin, socket).find((row) => row.startsWith(`${witness.paneId}|`));
        assert.ok(original);
        execFileSync(bin, ['-L', socket, 'respawn-pane', '-k', '-t', witness.paneId]);
        const successor = rows(bin, socket).find((row) => row.startsWith(`${witness.paneId}|`));
        const successorPid = successor.split('|')[1];
        assert.notEqual(successorPid, witness.panePid);
        assert.equal(successor.split('|')[3], original.split('|')[3], 'no-arg respawn must preserve stored argv');
        await until(
          () => readFileSync(barrier, 'utf8') === `${witness.paneId}.${successorPid}`,
          'successor must also stop before publishing',
        );
        assert.equal(alive(successorPid), true);
        assert.equal(settled, false);
        abort.abort();
        await until(() => !existsSync(witness.gate), 'abort must close the empty gate');
        await delay(150);
        assert.equal(alive(successorPid), true, 'successor stays at the barrier until explicitly released');
        assert.equal(settled, false, 'cancellation must wait while the pre-claim successor remains alive');
        assert.deepEqual(rows(bin, socket), [...siblings, successor]);
        writeFileSync(release, '');
        const result = await outcome;
        assert.equal(result.error?.name, 'AbortError');
        assert.equal(alive(witness.panePid), false);
        assert.equal(alive(successorPid), false, 'successor must have exited when cancellation returns');
        assert.deepEqual(rows(bin, socket), siblings, 'no unclaimed pane may remain when cancellation returns');
        assert.equal(existsSync(started), false, 'neither unclaimed launcher may exec the agent');
        assert.equal(alive(witness.clientPid), false, 'forwarding client must be reaped');
      } finally {
        writeFileSync(release, '');
        abort.abort();
        await outcome;
        gateway.tmuxBin = bin;
        await gateway.destroyServer(wt);
        if (witness) rmSync(witness.gate, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
