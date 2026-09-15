import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTmuxAgentCarrierSessionFactory } from '../dist/domains/terminal/tmux-agent-carrier-session.js';
import { spawnCliInTmux } from '../dist/domains/terminal/tmux-agent-spawner.js';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function panes(bin, socket) {
  try {
    return execFileSync(
      bin,
      ['-L', socket, 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{pane_start_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '';
  }
}

for (const consumer of ['stream', 'duplex']) {
  test(`${consumer} rejects an already cancelled setup before any pane creation`, async () => {
    const abort = AbortSignal.abort();
    let calls = 0;
    const gateway = {
      createAgentPaneLease: async () => {
        calls++;
        throw new Error('must not create');
      },
    };
    const options = {
      command: '/bin/sleep',
      args: ['30'],
      signal: abort,
      invocationId: randomUUID(),
      worktreeId: 'pre-aborted',
    };
    const setup =
      consumer === 'stream'
        ? spawnCliInTmux(options, { tmuxGateway: gateway }).next()
        : createTmuxAgentCarrierSessionFactory({ tmuxGateway: gateway, worktreeId: 'pre-aborted', userId: 'test' })(
            options,
          );
    await assert.rejects(setup, { name: 'AbortError' });
    assert.equal(calls, 0);
  });
  for (const { existing, stage } of [
    { existing: false, stage: 'creation' },
    { existing: true, stage: 'creation' },
    { existing: true, stage: 'discovery' },
  ]) {
    test(
      `${consumer} cancels a stalled ${existing ? 'existing' : 'fresh'} ${stage} and reclaims only its own pane`,
      { timeout: 12000 },
      async () => {
        const gateway = new TmuxGateway();
        const realBin = gateway.tmuxBin;
        const wt = `test-setup-cancel-${randomUUID()}`;
        const socket = gateway.socketName(wt);
        const directory = mkdtempSync(join(tmpdir(), 'catcafe-setup-abort-'));
        const witnessPath = join(directory, 'witness.json');
        const abort = new AbortController();
        let witness;
        let settled;
        let timer;
        try {
          if (existing) await gateway.createAgentPaneLease(wt, { cwd: directory, command: ['/bin/sleep', '30'] });
          const before = panes(realBin, socket);
          writeFileSync(
            join(directory, 'control.json'),
            JSON.stringify({ bin: realBin, socket, stage, witness: witnessPath }),
          );
          const proxy = join(directory, 'tmux.cjs');
          writeFileSync(
            proxy,
            `#!${process.execPath}\n${readFileSync(new URL('./fixtures/tmux-setup-stall-proxy.cjs', import.meta.url), 'utf8')}`,
            { mode: 0o700 },
          );
          gateway.tmuxBin = proxy;
          const options = {
            command: '/bin/sleep',
            args: ['30'],
            cwd: directory,
            signal: abort.signal,
            invocationId: randomUUID(),
            worktreeId: wt,
            firstEventTimeoutMs: 0,
            timeoutMs: 0,
          };
          const setup =
            consumer === 'stream'
              ? spawnCliInTmux(options, { tmuxGateway: gateway }).next()
              : createTmuxAgentCarrierSessionFactory({ tmuxGateway: gateway, worktreeId: wt, userId: 'test' })(options);
          settled = setup.then(
            (value) => ({ kind: 'resolved', value }),
            (error) => ({ kind: 'rejected', error }),
          );
          const deadline = Date.now() + 6000;
          while (!existsSync(witnessPath) && Date.now() < deadline) await delay(10);
          assert.ok(existsSync(witnessPath), 'the fixture must reach the intended setup stage before cancellation');
          witness = JSON.parse(readFileSync(witnessPath, 'utf8'));
          if (stage === 'creation')
            assert.match(
              witness.state,
              new RegExp(`^${witness.pane} [1-9]\\d* 0 .*/env CAT_CAFE_PANE_TOKEN=[a-f0-9-]{36} .*`, 'm'),
              'real live pane must have its creation token',
            );
          assert.equal(alive(witness.clientPid), true, 'the creation client must still be withholding the receipt');
          abort.abort();
          const outcome = await Promise.race([
            settled,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ kind: 'pending' }), 2000);
            }),
          ]);
          assert.equal(
            outcome.kind,
            'rejected',
            'setup abort must settle without waiting for the stalled creation receipt',
          );
          assert.equal(outcome.error.name, 'AbortError');
          assert.equal(alive(witness.clientPid), false, 'the cancelled creation client must be reaped');
          assert.equal(
            panes(realBin, socket),
            before,
            'rollback must remove only its original pane and preserve siblings',
          );
          if (witness.directory)
            assert.equal(
              existsSync(witness.directory),
              false,
              'private invocation files must be removed on setup abort',
            );
        } finally {
          clearTimeout(timer);
          abort.abort();
          if (witness && alive(witness.clientPid)) process.kill(witness.clientPid, 'SIGKILL');
          await settled;
          gateway.tmuxBin = realBin;
          await gateway.destroyServer(wt);
          if (witness?.directory) rmSync(witness.directory, { recursive: true, force: true });
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
}
