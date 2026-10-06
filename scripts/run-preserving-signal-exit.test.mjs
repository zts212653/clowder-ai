import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(root, 'scripts/run-preserving-signal-exit.mjs');

test('the Web build launches a JS entry instead of a Windows .cmd shim', () => {
  const build = JSON.parse(fs.readFileSync(path.join(root, 'packages/web/package.json'))).scripts.build;
  assert.match(build, /run-preserving-signal-exit\.mjs node \.\/node_modules\/next\/dist\/bin\/next build$/);
});

test('the exact Web build carrier preserves literal args, spaces and exit status', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'next build & args '));
  try {
    const entry = path.join(fixture, 'node_modules/next/dist/bin/next');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);');
    const args = ['build', '& echo INJECTED', '%PATH%', 'a"b', '(x)', 'space here', '!variable!'];
    const result = spawnSync(process.execPath, [wrapper, 'node', './node_modules/next/dist/bin/next', ...args], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('missing command and missing usage fail closed', () => {
  assert.equal(spawnSync(process.execPath, [wrapper]).status, 64);
  assert.equal(spawnSync(process.execPath, [wrapper, 'not-a-real-clowder-command'], { stdio: 'ignore' }).status, 1);
});

for (const [signal, exit] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`the executable carrier preserves ${signal}`, { skip: process.platform === 'win32' }, async () => {
    const child = spawn(process.execPath, [wrapper, 'node', '-e', 'console.log("READY"); setInterval(() => {}, 100);']);
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
    try {
      await new Promise((resolve) => child.stdout.once('data', resolve));
      child.kill(signal);
      assert.equal(await done, exit);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  });
}
