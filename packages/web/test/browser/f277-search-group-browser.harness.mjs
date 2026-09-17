import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSearchGroupApi } from './f277-search-group.harness.mjs';
import { availablePort, stopChild } from './f290-runtime-journey.harness.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');

async function waitForPreview(url, child, output) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`F277 Next preview exited before readiness:\n${output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // The isolated preview is still starting or compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`F277 Next preview did not become ready:\n${output()}`);
}

/** Owns synthetic API data and a separate Next dist; never borrows a running Café. */
export async function startSearchGroupBrowserFixture() {
  const sync = spawnSync(process.execPath, [path.join(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  const api = await startSearchGroupApi();
  let nextDev;
  let server;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (server) await stopChild(server);
    } finally {
      try {
        await api.close();
      } finally {
        await nextDev?.cleanup();
      }
    }
  };

  try {
    nextDev = await createNextDevTestEnvironment('f277-search-group', {
      NEXT_PUBLIC_API_URL: api.url,
      API_SERVER_PORT: new URL(api.url).port,
    });
    const port = await availablePort();
    const webUrl = `http://127.0.0.1:${port}`;
    let output = '';
    server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: nextDev.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-8_000);
      });
    }
    await new Promise((resolve, reject) => {
      server.once('spawn', resolve);
      server.once('error', reject);
    });
    await waitForPreview(`${webUrl}/dev/f277-attention-preview/search`, server, () => output);
    return { apiUrl: api.url, webUrl, store: api.store, close };
  } catch (error) {
    await close();
    throw error;
  }
}
