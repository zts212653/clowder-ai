import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PreviewGateway } from '../../../dist/domains/preview/preview-gateway.js';

/** Spin up a fake dev server that returns HTML with iframe-blocking headers */
function createFakeDevServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'; default-src 'self'",
      });
      res.end(`<h1>Hello from dev server</h1><p>path=${req.url}</p>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

describe('PreviewGateway', () => {
  let fakeDevServer;
  let gateway;

  before(async () => {
    fakeDevServer = await createFakeDevServer();
    gateway = new PreviewGateway({ port: 0 }); // random port
    await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    await new Promise((resolve) => fakeDevServer.server.close(() => resolve()));
  });

  it('proxies request to target dev server', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Hello from dev server'));
  });

  it('strips X-Frame-Options from proxied response', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    assert.equal(res.headers['x-frame-options'], undefined);
  });

  it('strips CSP frame-ancestors from proxied response', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    const csp = res.headers['content-security-policy'];
    if (csp) {
      assert.ok(!csp.includes('frame-ancestors'), `CSP still contains frame-ancestors: ${csp}`);
    }
    // If CSP is fully removed, that's also fine
  });

  it('preserves non-frame-ancestors CSP directives', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    const csp = res.headers['content-security-policy'];
    if (csp) {
      assert.ok(csp.includes('default-src'), 'Other CSP directives should be preserved');
    }
  });

  it('strips __preview_port from forwarded URL', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/some/path?__preview_port=${fakeDevServer.port}&foo=bar`;
    const res = await httpGet(url);
    assert.ok(res.body.includes('path=/some/path?foo=bar'), `Unexpected body: ${res.body}`);
  });

  it('rejects excluded ports', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=6399`;
    const res = await httpGet(url);
    assert.equal(res.status, 403);
  });

  it('rejects missing port param', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/`;
    const res = await httpGet(url);
    assert.equal(res.status, 400);
  });

  it('rejects non-loopback host', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}&__preview_host=192.168.1.1`;
    const res = await httpGet(url);
    assert.equal(res.status, 403);
  });

  it('returns 502 for unreachable target', async () => {
    // Port 1025 is unlikely to have a server
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=1025`;
    const res = await httpGet(url);
    assert.equal(res.status, 502);
  });

  it('injects WebSocket port patch script into HTML responses', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    assert.equal(res.status, 200);
    // The injected script should contain the target port for WS patching
    assert.ok(
      res.body.includes('__preview_port'),
      `HTML should contain WS patch with __preview_port, got: ${res.body.slice(0, 300)}`,
    );
    assert.ok(
      res.body.includes(`${fakeDevServer.port}`),
      `WS patch script should contain target port ${fakeDevServer.port}`,
    );
    assert.ok(res.body.includes('WebSocket'), 'WS patch script should reference WebSocket constructor');
  });

  it('WS patch script contains WebSocket constructor override with correct port', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    // The WS patch must override the WebSocket constructor so HMR connections
    // include __preview_port, allowing the gateway to proxy them correctly
    assert.ok(res.body.includes('cat-cafe-ws-patch'), 'Should inject ws-patch script tag');
  });

  it('rejects start when configured port is already in use', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const blockedPort = typeof address === 'object' && address ? address.port : 0;
    const blockedGateway = new PreviewGateway({ port: blockedPort });

    await assert.rejects(blockedGateway.start(), /EADDRINUSE/);
    await blockedGateway.stop();
    await new Promise((resolve) => blocker.close(() => resolve()));
  });
});
