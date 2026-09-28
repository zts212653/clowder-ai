import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
function hasStarted(path, pid) {
  return existsSync(path) && readFileSync(path, 'utf8').split('\n').includes(String(pid));
}
async function until(check, label) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), label);
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
  for (const mode of ['before-claim', 'claimed-successor', 'successor-race', 'normal']) {
    test(`${existing ? 'existing' : 'fresh'} creation claim: ${mode}`, { timeout: 15000 }, async () => {
      const gateway = new TmuxGateway();
      const bin = gateway.tmuxBin;
      const wt = `test-creation-claim-${randomUUID()}`;
      const socket = gateway.socketName(wt);
      const dir = mkdtempSync(join(tmpdir(), 'catcafe-claim-test-'));
      const barrier = join(dir, 'barrier');
      const release = join(dir, 'release');
      const witnessPath = join(dir, 'witness');
      const started = join(dir, 'started');
      const abort = new AbortController();
      let outcome;
      let witness;
      try {
        if (existing) await gateway.createAgentPaneLease(wt, { command: ['/bin/sleep', '30'], cwd: dir });
        const before = rows(bin, socket);
        writeFileSync(
          join(dir, 'control.json'),
          JSON.stringify({ bin, socket, mode, barrier, release, witness: witnessPath }),
        );
        const proxy = join(dir, 'tmux.cjs');
        writeFileSync(
          proxy,
          `#!${process.execPath}\n${readFileSync(new URL('./fixtures/tmux-claim-barrier-proxy.cjs', import.meta.url), 'utf8')}`,
          { mode: 0o700 },
        );
        gateway.tmuxBin = proxy;
        outcome = gateway
          .createAgentPaneLease(wt, {
            command: ['/bin/sh', '-c', `echo $$ >> '${started}'; exec /bin/sleep 30`],
            cwd: dir,
            signal: abort.signal,
          })
          .then(
            (lease) => ({ lease }),
            (error) => ({ error }),
          );
        await until(() => existsSync(witnessPath), 'real tmux must have created the pane');
        witness = JSON.parse(readFileSync(witnessPath, 'utf8'));
        const original = rows(bin, socket).find((row) => row.startsWith(`${witness.paneId}|`));
        assert.ok(original);
        assert.equal(alive(witness.panePid), true);
        if (mode === 'before-claim') {
          await until(() => existsSync(barrier), 'launcher must stop before the publish syscall');
          assert.equal(existsSync(started), false, 'agent cannot exec before publishing');
          assert.throws(() => readlinkSync(join(witness.gate, 'claim')), { code: 'ENOENT' });
          abort.abort();
          await until(() => !existsSync(witness.gate), 'abort must close the empty gate before reading a claim');
          writeFileSync(release, '');
          const result = await outcome;
          assert.equal(existsSync(started), false, 'closed gate must prevent the delayed agent from ever starting');
          assert.equal(result.error?.name, 'AbortError');
          await until(() => !alive(witness.panePid), 'late launcher must exit');
          assert.equal(existsSync(started), false, 'closed gate must prevent the delayed agent from ever starting');
          assert.deepEqual(rows(bin, socket), before, 'late launcher must clean only its own pane');
        } else {
          await until(() => hasStarted(started, witness.panePid), 'original agent must start after publishing');
          const firstClaim = readlinkSync(join(witness.gate, 'claim'));
          assert.equal(firstClaim, `${witness.paneId}.${witness.panePid}`);
          let lease;
          if (mode === 'normal') {
            lease = (await outcome).lease;
            assert.ok(lease, 'successful creation must retain the claim until lease cleanup');
          }
          execFileSync(bin, ['-L', socket, 'respawn-pane', '-k', '-t', witness.paneId]);
          const successor = rows(bin, socket).find((row) => row.startsWith(`${witness.paneId}|`));
          const successorPid = successor.split('|')[1];
          assert.notEqual(successorPid, witness.panePid);
          assert.equal(successor.split('|')[3], original.split('|')[3], 'no command means identical stored argv');
          if (mode === 'successor-race') {
            await until(() => existsSync(barrier), 'successor must receive EEXIST before abort closes the gate');
            assert.equal(readFileSync(barrier, 'utf8'), `${witness.paneId}.${successorPid}`);
            assert.equal(
              readlinkSync(join(witness.gate, 'claim')),
              firstClaim,
              'successor cannot replace the complete claim',
            );
            abort.abort();
            assert.equal((await outcome).error?.name, 'AbortError');
            assert.equal(existsSync(witness.gate), false);
            writeFileSync(release, '');
            await until(
              () => hasStarted(started, successorPid),
              'EEXIST successor must still exec after parent cleanup',
            );
          } else {
            await until(() => hasStarted(started, successorPid), 'no-arg recovery must work after successful creation');
            assert.equal(
              readlinkSync(join(witness.gate, 'claim')),
              firstClaim,
              'successor cannot replace the complete claim',
            );
            if (mode === 'normal') {
              assert.equal(gateway.killAgentPane(lease), false, 'old lease cleanup must reject the new PID');
            } else {
              abort.abort();
              assert.equal((await outcome).error?.name, 'AbortError');
            }
            assert.equal(existsSync(witness.gate), false, 'lease cleanup must remove its private gate');
          }
          const expected = [...before, successor];
          await until(() => !alive(witness.panePid), 'original process must be gone');
          await delay(2200);
          assert.equal(alive(successorPid), true, 'unowned successor must outlive cleanup');
          assert.deepEqual(rows(bin, socket), expected, 'sibling and successor must remain unchanged');
        }
        assert.equal(alive(witness.clientPid), false, 'creation client must be reaped');
      } finally {
        writeFileSync(release, '');
        abort.abort();
        await outcome;
        gateway.tmuxBin = bin;
        await gateway.destroyServer(wt);
        if (witness) rmSync(witness.gate, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
