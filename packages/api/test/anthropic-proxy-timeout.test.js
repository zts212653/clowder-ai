/**
 * AC-C4: upstream fetch timeout tests
 * - hung upstream → proxy returns 504
 * - slow but streaming upstream → proxy does NOT truncate
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const PROXY_SCRIPT = resolve(import.meta.dirname, '../../../scripts/anthropic-proxy.mjs');

/** Start proxy pointing to given upstreams config, with given timeout. */
async function startProxy(upstreamsPath, timeoutMs, envOverrides = {}) {
  const port = await getFreePort();
  const proc = spawn('node', [PROXY_SCRIPT, '--port', String(port), '--upstreams', upstreamsPath], {
    env: {
      ...process.env,
      ANTHROPIC_PROXY_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('proxy start timeout')), 5000);
    proc.stdout.on('data', (data) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { port, proc };
}

function requestViaHttp({ port, path, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(3000),
    });
    req.then(async (res) => {
      resolve({
        statusCode: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: await res.text(),
      });
    }, reject);
  });
}

async function getFreePort() {
  const server = createNetServer();
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

describe('anthropic-proxy upstream timeout (AC-C4)', () => {
  let hungServer;
  let hungPort;
  let proxyProcess;
  let proxyPort;
  let tmpDir;

  before(async () => {
    // Server that accepts connections but never responds
    hungServer = createHttpServer((_req, _res) => {
      // Intentionally never respond
    });
    await new Promise((r) => hungServer.listen(0, '127.0.0.1', r));
    hungPort = hungServer.address().port;

    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-timeout-'));
    const catCafeDir = join(tmpDir, '.cat-cafe');
    mkdirSync(catCafeDir, { recursive: true });
    const upstreamsPath = join(catCafeDir, 'proxy-upstreams.json');
    writeFileSync(upstreamsPath, JSON.stringify({ 'hung-upstream': `http://127.0.0.1:${hungPort}` }));

    const proxy = await startProxy(upstreamsPath, 1000);
    proxyPort = proxy.port;
    proxyProcess = proxy.proc;
  });

  after(async () => {
    if (proxyProcess) {
      proxyProcess.kill('SIGTERM');
      await new Promise((r) => proxyProcess.on('close', r));
    }
    if (hungServer) hungServer.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 504 when upstream does not respond within timeout', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/hung-upstream/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
      signal: AbortSignal.timeout(3000),
    });

    assert.equal(res.status, 504, `expected 504 but got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error.type, 'proxy_timeout');
  });
});

describe('anthropic-proxy does NOT truncate slow streaming (P1 review fix)', () => {
  let slowServer;
  let slowPort;
  let proxyProcess;
  let proxyPort;
  let tmpDir;

  before(async () => {
    // Server that sends headers immediately, then streams data slowly
    // Total stream time: ~1.5s (exceeds the 1s connect timeout)
    slowServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n');
      // Send second chunk after 1.5s — must NOT be truncated
      setTimeout(() => {
        res.write('event: message_stop\ndata: {}\n\n');
        res.end();
      }, 1500);
    });
    await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
    slowPort = slowServer.address().port;

    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-slow-'));
    const catCafeDir = join(tmpDir, '.cat-cafe');
    mkdirSync(catCafeDir, { recursive: true });
    const upstreamsPath = join(catCafeDir, 'proxy-upstreams.json');
    writeFileSync(upstreamsPath, JSON.stringify({ 'slow-upstream': `http://127.0.0.1:${slowPort}` }));

    // Connect timeout = 1s, but stream should NOT be cut at 1s
    const proxy = await startProxy(upstreamsPath, 1000);
    proxyPort = proxy.port;
    proxyProcess = proxy.proc;
  });

  after(async () => {
    if (proxyProcess) {
      proxyProcess.kill('SIGTERM');
      await new Promise((r) => proxyProcess.on('close', r));
    }
    if (slowServer) slowServer.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('receives complete stream even when it takes longer than connect timeout', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/slow-upstream/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [], stream: true }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    // Must contain BOTH events — stream was not truncated
    assert.ok(body.includes('event: ping'), 'should contain first event');
    assert.ok(body.includes('event: message_stop'), 'should contain final event (not truncated)');
  });
});

describe('anthropic-proxy Phase E upstream hardening', () => {
  it('retries transient upstream socket failures and succeeds on retry', async () => {
    let attempts = 0;
    const upstream = createHttpServer((req, res) => {
      attempts += 1;
      if (attempts === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, attempts }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    const tmpDir = mkdtempSync(join(tmpdir(), 'proxy-network-retry-'));
    const catCafeDir = join(tmpDir, '.cat-cafe');
    mkdirSync(catCafeDir, { recursive: true });
    const upstreamsPath = join(catCafeDir, 'proxy-upstreams.json');
    writeFileSync(upstreamsPath, JSON.stringify({ sponsor: `http://127.0.0.1:${upstreamPort}` }));

    const proxy = await startProxy(upstreamsPath, 500, { ANTHROPIC_PROXY_MAX_RETRIES: '1' });

    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/sponsor/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
        signal: AbortSignal.timeout(3000),
      });

      assert.equal(res.status, 200);
      assert.equal(attempts, 2);
      assert.deepEqual(await res.json(), { ok: true, attempts: 2 });
    } finally {
      proxy.proc.kill('SIGTERM');
      await new Promise((resolve) => proxy.proc.on('close', resolve));
      upstream.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes causeCode for terminal network failures', async () => {
    const upstreamPort = await getFreePort();
    const tmpDir = mkdtempSync(join(tmpdir(), 'proxy-cause-code-'));
    const catCafeDir = join(tmpDir, '.cat-cafe');
    mkdirSync(catCafeDir, { recursive: true });
    const upstreamsPath = join(catCafeDir, 'proxy-upstreams.json');
    writeFileSync(upstreamsPath, JSON.stringify({ sponsor: `http://127.0.0.1:${upstreamPort}` }));

    const proxy = await startProxy(upstreamsPath, 500, { ANTHROPIC_PROXY_MAX_RETRIES: '0' });

    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/sponsor/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
        signal: AbortSignal.timeout(3000),
      });

      const body = await res.json();
      assert.equal(res.status, 502);
      assert.equal(body.error.type, 'proxy_error');
      assert.equal(body.error.causeCode, 'ECONNREFUSED');
      assert.equal(body.error.retryable, true);
    } finally {
      proxy.proc.kill('SIGTERM');
      await new Promise((resolve) => proxy.proc.on('close', resolve));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves request forwarding when sanitization changes body length', async () => {
    const requests = [];
    const upstream = createHttpServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    const tmpDir = mkdtempSync(join(tmpdir(), 'proxy-content-length-'));
    const catCafeDir = join(tmpDir, '.cat-cafe');
    mkdirSync(catCafeDir, { recursive: true });
    const upstreamsPath = join(catCafeDir, 'proxy-upstreams.json');
    writeFileSync(upstreamsPath, JSON.stringify({ sponsor: `http://127.0.0.1:${upstreamPort}` }));

    const proxy = await startProxy(upstreamsPath, 1000, { ANTHROPIC_PROXY_MAX_RETRIES: '0' });

    const requestPayload = {
      model: 'claude-opus-4-6',
      max_tokens: 1,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning', signature: 'sig' },
            { type: 'text', text: 'visible context' },
          ],
        },
        { role: 'user', content: 'ping' },
      ],
    };
    const requestBody = JSON.stringify(requestPayload);

    try {
      const response = await requestViaHttp({
        port: proxy.port,
        path: '/sponsor/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(requestBody)),
        },
        body: requestBody,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);

      const forwardedPayload = JSON.parse(requests[0].body);
      assert.deepEqual(forwardedPayload.messages[0].content, [{ type: 'text', text: 'visible context' }]);
      assert.equal(requests[0].headers['content-length'], String(Buffer.byteLength(requests[0].body)));
    } finally {
      proxy.proc.kill('SIGTERM');
      await new Promise((resolve) => proxy.proc.on('close', resolve));
      upstream.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
