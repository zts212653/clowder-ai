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
    `start:direct waits for SIGINT cleanup (${viaPnpm ? 'pnpm' : 'node wrapper'})`,
    { timeout: 10_000, skip: process.platform === 'win32' },
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'cat-cafe-start-entry-signal-'));
      const scripts = join(fixture, 'scripts');
      const marker = join(fixture, 'cleanup.log');
      mkdirSync(join(scripts, 'lib'), { recursive: true });
      cpSync(join(ROOT, 'scripts', 'start-entry.mjs'), join(scripts, 'start-entry.mjs'));
      writeFileSync(join(scripts, 'lib', 'platform-status.mjs'), 'export function runWindowsStatus() {}\n', 'utf8');
      writeFileSync(
        join(scripts, 'start-dev.sh'),
        `#!/usr/bin/env bash\nmarker=${JSON.stringify(marker)}\ncleanup() { printf 'cleanup-start\\n' >> "$marker"; sleep 0.4; printf 'cleanup-done\\n' >> "$marker"; }\ntrap 'trap "" INT TERM; cleanup; exit 130' INT\ntrap 'trap "" INT TERM; cleanup; exit 143' TERM\nprintf 'launcher-ready\\n'\nwhile :; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          private: true,
          scripts: { 'start:direct': 'node ./scripts/start-entry.mjs start:direct --profile=opensource' },
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
        // Like start-dev.sh finish_launcher, the fixture ignores repeated signals during cleanup.
        process.kill(-command.pid, 'SIGINT');
        await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').includes('cleanup-start'));
        process.kill(-command.pid, 'SIGINT');
        const exit = await exited;
        const cleanup = readFileSync(marker, 'utf8');
        assert.match(cleanup, /cleanup-done/, `wrapper exited before cleanup completed\n${output}`);
        // pnpm may consume SIGINT and return zero after its child has finished.
        // The wrapper itself must preserve the signal status; both paths await cleanup.
        assert.ok(
          exit.code === 130 || exit.signal === 'SIGINT' || (viaPnpm && exit.code === 0),
          JSON.stringify({ exit, output }),
        );
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
