import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PreviewGateway } from '../../../dist/domains/preview/preview-gateway.js';

/** Spin up a fake dev server that returns HTML with iframe-blocking headers */
function createFakeDevServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end('body { color: rgb(1, 2, 3); }');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'; default-src 'self'",
      });
      res.end(`<link rel="stylesheet" href="/style.css"><h1>Hello from dev server</h1><p>path=${req.url}</p>`);
    });
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.end();
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

/** HTTP GET routed to the gateway with an explicit preview hostname. */
function httpGetWithHost(gatewayPort, previewHostname, path = '/', origin) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${previewHostname}:${gatewayPort}` };
    if (origin) headers.Origin = origin;
    http
      .get({ hostname: '127.0.0.1', port: gatewayPort, path, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

/** HTTP GET with explicit Origin header (F156 D-5) */
function httpGetWithOrigin(url, origin) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: { Origin: origin },
    };
    http
      .get(opts, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

/** Attempt raw HTTP Upgrade with Origin header (F156 D-5) */
function wsUpgradeWithOrigin(gatewayPort, targetPort, origin) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      path: `/?__preview_port=${targetPort}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: origin,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve({ status: 101 });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end();
  });
}

function wsUpgradeWithHost(gatewayPort, previewHostname, origin) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      path: '/__vite_hmr',
      headers: {
        Host: `${previewHostname}:${gatewayPort}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: origin,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end();
  });
}

describe('PreviewGateway', () => {
  let fakeDevServer;
  let otherFakeDevServer;
  let gateway;

  before(async () => {
    fakeDevServer = await createFakeDevServer();
    otherFakeDevServer = await createFakeDevServer();
    gateway = new PreviewGateway({ port: 0 }); // random port
    await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    await new Promise((resolve) => fakeDevServer.server.close(() => resolve()));
    await new Promise((resolve) => otherFakeDevServer.server.close(() => resolve()));
  });

  it('proxies request to target dev server', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Hello from dev server'));
  });

  it('keeps the target identity for root-relative subresources', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const document = await httpGetWithHost(gateway.actualPort, previewHostname, '/');
    assert.equal(document.status, 200);
    assert.ok(document.body.includes('href="/style.css"'));

    // Browsers do not copy the document query string onto /style.css. The
    // preview origin itself must therefore carry the target identity.
    const stylesheet = await httpGetWithHost(gateway.actualPort, previewHostname, '/style.css');
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.body, /rgb\(1, 2, 3\)/);
  });

  it('fails closed when hostname and legacy query identify different targets', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const res = await httpGetWithHost(
      gateway.actualPort,
      previewHostname,
      `/?__preview_port=${otherFakeDevServer.port}`,
    );
    assert.equal(res.status, 400);
  });

  it('fails closed when a preview hostname carries a malformed legacy identity', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const res = await httpGetWithHost(gateway.actualPort, previewHostname, '/?__preview_port=not-a-port');
    assert.equal(res.status, 400);
  });

  it('fails closed when reserved legacy identity parameters are duplicated', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const duplicatePort = await httpGetWithHost(
      gateway.actualPort,
      previewHostname,
      `/?__preview_port=${fakeDevServer.port}&__preview_port=${fakeDevServer.port}`,
    );
    assert.equal(duplicatePort.status, 400);

    const duplicateHost = await httpGetWithHost(
      gateway.actualPort,
      previewHostname,
      '/?__preview_host=localhost&__preview_host=127.0.0.1',
    );
    assert.equal(duplicateHost.status, 400);
  });

  it('applies excluded-port validation to hostname identities', async () => {
    const res = await httpGetWithHost(gateway.actualPort, 'preview-6399.localhost');
    assert.equal(res.status, 403);
  });

  it('allows same-preview-origin browser requests', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const origin = `http://${previewHostname}:${gateway.actualPort}`;
    const res = await httpGetWithHost(gateway.actualPort, previewHostname, '/style.css', origin);
    assert.equal(res.status, 200);
  });

  it('rejects browser requests whose preview Origin names a different target', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const otherOrigin = `http://preview-${otherFakeDevServer.port}.localhost:${gateway.actualPort}`;
    const res = await httpGetWithHost(gateway.actualPort, previewHostname, '/style.css', otherOrigin);
    assert.equal(res.status, 403);
  });

  it('routes WebSocket upgrades through the preview hostname without a query', async () => {
    const previewHostname = `preview-${fakeDevServer.port}.localhost`;
    const origin = `http://${previewHostname}:${gateway.actualPort}`;
    const result = await wsUpgradeWithHost(gateway.actualPort, previewHostname, origin);
    assert.equal(result.status, 101);
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

  // --- F156 D-5: Origin validation ---

  it('rejects HTTP request with evil Origin', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGetWithOrigin(url, 'https://evil.example');
    assert.equal(res.status, 403);
    assert.ok(res.body.includes('Origin'), 'Should mention Origin in error');
  });

  it('allows HTTP request with valid localhost Origin', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGetWithOrigin(url, 'http://localhost:3003');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Hello from dev server'));
  });

  it('allows HTTP request with loopback Origin', async () => {
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGetWithOrigin(url, 'http://127.0.0.1:5173');
    assert.equal(res.status, 200);
  });

  it('allows HTTP request without Origin header (non-browser)', async () => {
    // curl / server-to-server requests have no Origin — must be allowed
    const url = `http://127.0.0.1:${gateway.actualPort}/?__preview_port=${fakeDevServer.port}`;
    const res = await httpGet(url);
    assert.equal(res.status, 200);
  });

  it('rejects WS upgrade with evil Origin', async () => {
    const result = await wsUpgradeWithOrigin(gateway.actualPort, fakeDevServer.port, 'https://evil.example');
    assert.equal(result.status, 403);
  });

  it('allows WS upgrade with valid Origin', async () => {
    const result = await wsUpgradeWithOrigin(gateway.actualPort, fakeDevServer.port, 'http://localhost:3003');
    assert.equal(result.status, 101);
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
