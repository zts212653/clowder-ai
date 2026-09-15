import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

function panes(gateway, wt) {
  try {
    return execFileSync(
      gateway.tmuxBin,
      [
        '-L',
        gateway.socketName(wt),
        'list-panes',
        '-a',
        '-F',
        '#{pane_id} #{pane_pid} #{pane_dead} #{pane_start_command}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n');
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const existing of [false, true]) {
  for (const fault of [
    { name: 'empty receipt', receipt: '', exitCode: 0, rename: false },
    { name: 'malformed receipt after display rename', receipt: 'not-a-pane\n', exitCode: 0, rename: true },
    { name: 'client failure after creation', receipt: '', exitCode: 1, rename: false },
  ]) {
    test(
      `${existing ? 'existing' : 'fresh'} server: ${fault.name} rolls back only its actual creation`,
      { timeout: 10000 },
      async () => {
        const gateway = new TmuxGateway();
        const wt = `test-create-failure-${randomUUID()}`;
        const dir = mkdtempSync(join(tmpdir(), 'catcafe-create-failure-'));
        const realBin = gateway.tmuxBin;
        const ready = join(dir, 'ready');
        const witness = join(dir, 'witness.json');
        const proxy = join(dir, 'tmux-proxy.cjs');
        try {
          if (existing) await gateway.createAgentPaneLease(wt, { cwd: dir, command: ['/bin/sleep', '30'] });
          const siblings = panes(gateway, wt);
          writeFileSync(
            join(dir, 'control.json'),
            JSON.stringify({ bin: realBin, socket: gateway.socketName(wt), ready, witness, ...fault }),
          );
          const fixture = readFileSync(new URL('./fixtures/tmux-creation-receipt-proxy.cjs', import.meta.url), 'utf8');
          writeFileSync(proxy, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
          gateway.tmuxBin = proxy;
          await assert.rejects(
            gateway.createAgentPaneLease(wt, {
              cwd: dir,
              command: ['/bin/sh', '-c', `echo $$ > '${ready}'; exec /bin/sleep 30`],
            }),
            fault.exitCode ? /Command failed/ : /valid pane identity/,
          );
          gateway.tmuxBin = realBin;
          const created = JSON.parse(readFileSync(witness, 'utf8'));
          const commandPid = Number(readFileSync(ready, 'utf8'));
          assert.match(
            created.state,
            new RegExp(`^${created.paneId} ${commandPid} 0 .*/env CAT_CAFE_PANE_TOKEN=[a-f0-9-]{36} .*`, 'm'),
            'the command must really run with its original creation token before receipt damage',
          );
          assert.deepEqual(
            panes(gateway, wt),
            siblings,
            'failed identity acquisition must not leave an unowned pane or affect siblings',
          );
          const deadline = Date.now() + 2000;
          while (alive(commandPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(alive(commandPid), false, 'the real command process must terminate after rollback');
        } finally {
          gateway.tmuxBin = realBin;
          await gateway.destroyServer(wt);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }
}
