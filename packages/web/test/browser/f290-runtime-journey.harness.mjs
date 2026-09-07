import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');

export async function browserSessionToken(page, serviceUrl) {
  return page.evaluate(
    ({ origin, key }) => {
      const token = window.sessionStorage.getItem(`${key}:${origin}`);
      if (!token) throw new Error('Missing browser Service session');
      return token;
    },
    { origin: serviceUrl, key: 'collective-session' },
  );
}

export function startNext(port) {
  return spawn('pnpm', ['--filter', '@cat-cafe/web', 'exec', 'next', 'start', '-p', String(port)], {
    cwd: REPO_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function waitForHttp(url, child) {
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Next exited early (${child.exitCode}): ${output.join('').slice(-4000)}`);
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${output.join('').slice(-4000)}`);
}

export async function waitFor(predicate, failure) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failure);
}

export async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

export function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
