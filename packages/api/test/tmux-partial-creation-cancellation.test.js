import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function rows(bin, socket) {
  try {
    return execFileSync(
      bin,
      [
        '-L',
        socket,
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}|#{pane_pid}|#{@cat-cafe-lease}|#{pane_dead}|#{pane_start_command}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n');
  } catch {
    return [];
  }
}

for (const { existing, replace } of [false, true].flatMap((existing) =>
  [false, true].map((replace) => ({ existing, replace })),
)) {
  test(
    `${existing ? 'existing' : 'fresh'} partial creation ${replace ? 'preserves its successor' : 'reclaims its pane'} during the after-create hook`,
    { timeout: 10000 },
    async () => {
      const gateway = new TmuxGateway();
      const bin = gateway.tmuxBin;
      const wt = `test-partial-create-${randomUUID()}`;
      const socket = gateway.socketName(wt);
      const dir = mkdtempSync(join(tmpdir(), 'catcafe-partial-create-'));
      const marker = join(dir, 'hook-entered');
      const pidFile = join(dir, 'client-pid');
      const config = join(dir, 'tmux.conf');
      const started = join(dir, 'started');
      const abort = new AbortController();
      let outcome;
      try {
        if (existing) await gateway.createAgentPaneLease(wt, { command: ['/bin/sleep', '30'], cwd: dir });
        const before = rows(bin, socket);
        const hookName = existing ? 'after-new-window' : 'after-new-session';
        const hook = `run-shell '/usr/bin/touch ${marker}; /bin/sleep 2'`;
        writeFileSync(config, `set-hook -g ${hookName} "${hook}"\n`);
        if (existing) execFileSync(bin, ['-L', socket, 'set-hook', '-g', hookName, hook]);
        const wrapper = join(dir, 'tmux');
        writeFileSync(
          wrapper,
          `#!/bin/sh\nfor arg; do\ncase "$arg" in new-session|new-window) echo $$ > '${pidFile}';; esac\ndone\nexec '${bin}' -f '${config}' "$@"\n`,
          { mode: 0o700 },
        );
        gateway.tmuxBin = wrapper;
        const pending = gateway.createAgentPaneLease(wt, {
          command: ['/bin/sh', '-c', `echo $$ >> '${started}'; exec /bin/sleep 30`],
          cwd: dir,
          signal: abort.signal,
        });
        outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const deadline = Date.now() + 4000;
        while (!existsSync(marker) && Date.now() < deadline) await delay(10);
        assert.ok(existsSync(marker), 'a real after-create hook must enter before abort');
        const created = rows(bin, socket).find((row) => !before.includes(row));
        assert.ok(created, 'the real pane must already exist');
        const [paneId, panePid, lateStamp, dead] = created.split('|');
        assert.equal(lateStamp, '', 'abort must happen before the old queued token stamp');
        assert.equal(dead, '0');
        assert.equal(alive(Number(panePid)), true);
        const startedBy = Date.now() + 2000;
        while (
          (!existsSync(started) || !readFileSync(started, 'utf8').split('\n').includes(panePid)) &&
          Date.now() < startedBy
        )
          await delay(10);
        assert.ok(
          readFileSync(started, 'utf8').split('\n').includes(panePid),
          'original agent must start after claiming',
        );
        const clientPid = Number(readFileSync(pidFile, 'utf8'));
        assert.equal(alive(clientPid), true);
        // Display names are not creation identity, even before the hook returns.
        execFileSync(bin, ['-L', socket, 'rename-window', '-t', paneId, 'renamed-during-setup']);
        let expected = before;
        if (replace) {
          execFileSync(bin, ['-L', socket, 'respawn-pane', '-k', '-t', paneId]);
          expected = rows(bin, socket);
          const successor = expected.find((row) => row.startsWith(`${paneId}|`));
          assert.ok(successor, 'the successor must reuse the original pane address');
          assert.notEqual(successor.split('|')[1], panePid, 'the successor must have a different live PID');
          assert.equal(successor.split('|')[4], created.split('|')[4], 'no-arg respawn must inherit the start command');
          assert.equal(alive(Number(successor.split('|')[1])), true);
          const successorBy = Date.now() + 2000;
          while (
            !readFileSync(started, 'utf8').split('\n').includes(successor.split('|')[1]) &&
            Date.now() < successorBy
          )
            await delay(10);
          assert.ok(
            readFileSync(started, 'utf8').split('\n').includes(successor.split('|')[1]),
            'unowned successor must really start',
          );
        }
        abort.abort();
        const result = await outcome;
        assert.equal(result.error?.name, 'AbortError');
        assert.equal(alive(clientPid), false, 'the actual creation client must be reaped');
        assert.deepEqual(rows(bin, socket), expected, 'partial creation rollback must remove only its own live pane');
        const stoppedBy = Date.now() + 1000;
        while (alive(Number(panePid)) && Date.now() < stoppedBy) await delay(10);
        assert.equal(alive(Number(panePid)), false, 'the actual pane process must terminate');
        await delay(2200);
        assert.deepEqual(
          rows(bin, socket),
          expected,
          'the interrupted command queue must not revive or affect successors',
        );
      } finally {
        abort.abort();
        await outcome;
        gateway.tmuxBin = bin;
        await gateway.destroyServer(wt);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
