import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && address.port > 0, 'server should bind to a port');
  return address.port;
}

async function getFreePort() {
  const server = net.createServer();
  try {
    return await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address !== 'object') {
          reject(new Error('failed to allocate port'));
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function waitForMatch(child, regex, timeoutMs = 5000) {
  let output = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);

  const onData = (chunk) => {
    output += chunk.toString();
  };

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  try {
    while (!timedOut) {
      if (regex.test(output)) return output;
      await delay(25);
    }
    throw new Error(`Timed out waiting for proxy startup. Output:\n${output}`);
  } finally {
    clearTimeout(timer);
    child.stdout?.off('data', onData);
    child.stderr?.off('data', onData);
  }
}

async function startProxy(upstreams, envOverrides = {}) {
  const scriptPath = resolve(repoRoot, 'scripts', 'anthropic-proxy.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'anthropic-proxy-test-'));
  const upstreamsPath = join(tempDir, 'proxy-upstreams.json');
  const port = await getFreePort();

  await writeFile(upstreamsPath, `${JSON.stringify(upstreams, null, 2)}\n`, 'utf8');

  const child = spawn(process.execPath, [scriptPath, '--port', String(port), '--upstreams', upstreamsPath], {
    cwd: repoRoot,
    env: { ...process.env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.once('error', (err) => {
    throw err;
  });

  await waitForMatch(child, /\[anthropic-proxy\] listening on http:\/\/127\.0\.0\.1:/);

  return {
    child,
    port,
    async close() {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2000)]);
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test('anthropic proxy retries transient upstream socket failures and succeeds on retry', async () => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempts }));
  });

  const upstreamPort = await listen(upstream);
  const proxy = await startProxy(
    { sponsor: `http://127.0.0.1:${upstreamPort}` },
    {
      ANTHROPIC_PROXY_MAX_RETRIES: '1',
      ANTHROPIC_PROXY_UPSTREAM_TIMEOUT_MS: '200',
    },
  );

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/sponsor/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6' }),
      signal: AbortSignal.timeout(2000),
    });

    assert.equal(res.status, 200);
    assert.equal(attempts, 2);
    assert.deepEqual(await res.json(), { ok: true, attempts: 2 });
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(() => resolve()));
  }
});

test('anthropic proxy aborts hanging upstreams promptly and returns timeout diagnostics', async () => {
  const sockets = new Set();
  const upstream = http.createServer(() => {
    // Intentionally hang until the proxy aborts the request.
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const upstreamPort = await listen(upstream);
  const proxy = await startProxy(
    { sponsor: `http://127.0.0.1:${upstreamPort}` },
    {
      ANTHROPIC_PROXY_MAX_RETRIES: '0',
      ANTHROPIC_PROXY_UPSTREAM_TIMEOUT_MS: '100',
    },
  );

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/sponsor/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6' }),
      signal: AbortSignal.timeout(2000),
    });

    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), {
      type: 'error',
      error: {
        type: 'proxy_error',
        message: 'upstream request timed out',
        causeCode: 'UPSTREAM_TIMEOUT',
        retryable: true,
      },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await proxy.close();
    await new Promise((resolve) => upstream.close(() => resolve()));
  }
});

test('anthropic proxy includes cause codes for terminal network failures', async () => {
  const upstreamPort = await getFreePort();
  const proxy = await startProxy(
    { sponsor: `http://127.0.0.1:${upstreamPort}` },
    {
      ANTHROPIC_PROXY_MAX_RETRIES: '0',
      ANTHROPIC_PROXY_UPSTREAM_TIMEOUT_MS: '200',
    },
  );

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/sponsor/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6' }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.json();

    assert.equal(res.status, 502);
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'proxy_error');
    assert.equal(body.error.causeCode, 'ECONNREFUSED');
    assert.equal(body.error.retryable, true);
    assert.match(body.error.message, /connection refused/i);
  } finally {
    await proxy.close();
  }
});
