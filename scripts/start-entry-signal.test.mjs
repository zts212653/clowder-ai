import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      if (predicate()) return resolveWait();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for fixture state'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

for (const viaPnpm of [false, true])
  test(
    viaPnpm
      ? 'the start wrapper joins cleanup and preserves SIGINT status when launched by pnpm'
      : 'start:direct waits for repeated process-group SIGINT cleanup (node wrapper)',
    { timeout: 10_000, skip: process.platform === 'win32' },
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'cat-cafe-start-entry-signal-'));
      const scripts = join(fixture, 'scripts');
      const marker = join(fixture, 'cleanup.log');
      const wrapperPidFile = join(fixture, 'wrapper.pid');
      mkdirSync(join(scripts, 'lib'), { recursive: true });
      cpSync(join(ROOT, 'scripts', 'start-entry.mjs'), join(scripts, 'start-entry.mjs'));
      writeFileSync(join(scripts, 'lib', 'platform-status.mjs'), 'export function runWindowsStatus() {}\n', 'utf8');
      writeFileSync(
        join(scripts, 'start-dev.sh'),
        `#!/usr/bin/env bash\nmarker=${JSON.stringify(marker)}\nprintf '%s\\n' "$PPID" > ${JSON.stringify(wrapperPidFile)}\ncleanup() { printf 'cleanup-start\\n' >> "$marker"; sleep 0.4; printf 'cleanup-done\\n' >> "$marker"; }\ntrap 'trap "" INT TERM; cleanup; exit 130' INT\ntrap 'trap "" INT TERM; cleanup; exit 143' TERM\nprintf 'launcher-ready\\n'\nwhile :; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          private: true,
          scripts: {
            // Retain the lifecycle shell instead of relying on platform-specific tail exec.
            'start:direct':
              'node ./scripts/start-entry.mjs start:direct --profile=opensource; result=$?; exit "$result"',
          },
        }),
        'utf8',
      );

      let output = '';
      const command = spawn(
        viaPnpm ? 'pnpm' : process.execPath,
        viaPnpm ? ['start:direct'] : [join(scripts, 'start-entry.mjs'), 'start:direct', '--profile=opensource'],
        {
          cwd: fixture,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      for (const stream of [command.stdout, command.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          output += chunk;
        });
      }

      try {
        await waitFor(() => output.includes('launcher-ready'));
        const exited = new Promise((resolveExit, reject) => {
          command.once('error', reject);
          command.once('exit', (code, signal) => resolveExit({ code, signal }));
        });
        // pnpm owns its own shell/signal policy. Test our wrapper through pnpm,
        // and exercise terminal process-group signals directly on the wrapper.
        const wrapperPid = Number(readFileSync(wrapperPidFile, 'utf8').trim());
        assert.ok(Number.isSafeInteger(wrapperPid) && wrapperPid > 0 && wrapperPid !== process.pid);
        const signalTarget = viaPnpm ? wrapperPid : -command.pid;
        process.kill(signalTarget, 'SIGINT');
        await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').includes('cleanup-start'));
        process.kill(signalTarget, 'SIGINT');
        const exit = await exited;
        const cleanup = readFileSync(marker, 'utf8');
        assert.match(cleanup, /cleanup-done/, `wrapper exited before cleanup completed\n${output}`);
        assert.equal(exit.code, 130, JSON.stringify({ exit, output }));
        assert.equal(exit.signal, null, JSON.stringify({ exit, output }));
      } finally {
        if (command.exitCode === null && command.signalCode === null) {
          try {
            process.kill(-command.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
