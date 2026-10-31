import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-preserving-signal-exit.mjs');

test('web build runs its JS entry without a command shim and preserves literal arguments', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'next build & args '));
  try {
    const entry = path.join(fixture, 'node_modules/next/dist/bin/next');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);');
    const build = JSON.parse(readFileSync(path.join(ROOT, 'packages/web/package.json'), 'utf8')).scripts.build;
    const [, , ...command] = build.split(' ');
    const args = ['& echo INJECTED', '%PATH%', 'a"b', '(x)', 'space here', '!variable!'];
    const result = spawnSync(process.execPath, [RUNNER, ...command, ...args], {
      cwd: fixture,
      env: { ...process.env, PATH: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['build', ...args]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('node commands use the runtime that launched the wrapper without relying on PATH', () => {
  const result = spawnSync(process.execPath, [RUNNER, 'node', '-e', 'console.log(process.execPath)'], {
    env: { ...process.env, PATH: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
});

function observe(child) {
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
    });
  }
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    output: () => output,
    result,
    waitFor(pattern) {
      return new Promise((resolve, reject) => {
        const inspect = () => {
          if (pattern.test(output)) {
            cleanup();
            resolve();
          }
        };
        const fail = () => {
          cleanup();
          reject(new Error(`child exited before ${pattern}: ${output}`));
        };
        const cleanup = () => {
          child.stdout.off('data', inspect);
          child.stderr.off('data', inspect);
          child.off('exit', fail);
        };
        child.stdout.on('data', inspect);
        child.stderr.on('data', inspect);
        child.once('exit', fail);
        inspect();
      });
    },
  };
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(
    `preserves ${signal} when the child converts the signal to exit zero`,
    {
      timeout: 5_000,
      skip: process.platform === 'win32', // Windows kill does not deliver POSIX signal handlers.
    },
    async () => {
      const childScript = [
        `process.on('${signal}', () => { console.log('child:signal'); process.exit(0) })`,
        "console.log('child:ready')",
        'setInterval(() => {}, 1_000)',
      ].join(';');
      const wrapper = spawn(process.execPath, [RUNNER, process.execPath, '-e', childScript], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const observation = observe(wrapper);

      try {
        await observation.waitFor(/child:ready/);
        wrapper.kill(signal);
        assert.deepEqual(await observation.result, { code: exitCode, signal: null }, observation.output());
        assert.match(
          observation.output(),
          new RegExp(`\\[signal-exit\\] forwarding ${signal} .* preserving ${exitCode}`),
        );
        assert.match(observation.output(), /child:signal/);
      } finally {
        if (wrapper.exitCode === null) wrapper.kill('SIGTERM');
      }
    },
  );
}

test('preserves an ordinary child exit code', async () => {
  const wrapper = spawn(process.execPath, [RUNNER, process.execPath, '-e', 'process.exit(7)'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const observation = observe(wrapper);

  assert.deepEqual(await observation.result, { code: 7, signal: null }, observation.output());
});
