import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { PreviewGateway } from '../../../dist/domains/preview/preview-gateway.js';

describe('gateway bridge script injection', () => {
  let targetServer;
  let targetPort;
  let gateway;

  before(async () => {
    // Create a simple HTTP server that serves HTML and non-HTML
    targetServer = http.createServer((req, res) => {
      if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Test</title></head><body>Hello</body></html>');
      } else if (req.url === '/html-no-head') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>No head tag</body></html>');
      } else if (req.url === '/html-identity') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'identity' });
        res.end('<html><head><title>Identity</title></head><body>Identity encoded</body></html>');
      } else if (req.url === '/html-br') {
        // Simulate brotli-encoded HTML (gateway can't decode br)
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' });
        res.end('<html><head></head><body>Brotli</body></html>');
      } else if (req.url === '/css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end('body { color: red; }');
      } else if (req.url === '/js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('console.log("hi")');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head></head><body>Default</body></html>');
      }
    });
    await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    targetPort = targetServer.address().port;

    gateway = new PreviewGateway({ port: 0, host: '127.0.0.1' });
    await gateway.start();
  });

  after(async () => {
    await gateway.stop();
    await new Promise((resolve) => targetServer.close(resolve));
  });

  async function fetchViaGateway(path) {
    const url = `http://127.0.0.1:${gateway.actualPort}${path}?__preview_port=${targetPort}`;
    const res = await fetch(url);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  it('injects bridge script into HTML responses', async () => {
    const { text } = await fetchViaGateway('/html');
    assert.ok(text.includes('__catCafeBridge'), 'should contain bridge script');
    assert.ok(text.includes('<title>Test</title>'), 'should preserve original content');
  });

  it('injects script into HTML without <head> tag', async () => {
    const { text } = await fetchViaGateway('/html-no-head');
    assert.ok(text.includes('__catCafeBridge'), 'should contain bridge script even without head');
    assert.ok(text.includes('No head tag'), 'should preserve original content');
  });

  it('injects bridge into HTML with Content-Encoding: identity', async () => {
    const { body } = await new Promise((resolve, reject) => {
      const url = `http://127.0.0.1:${gateway.actualPort}/html-identity?__preview_port=${targetPort}`;
      http
        .get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), headers: res.headers }));
        })
        .on('error', reject);
    });
    assert.ok(body.includes('__catCafeBridge'), 'should inject bridge into identity-encoded HTML');
    assert.ok(body.includes('<title>Identity</title>'), 'should preserve original content');
  });

  it('passes through HTML with unsupported encoding (e.g. br) without injection', async () => {
    // Use raw http.get to avoid fetch's automatic brotli decompression
    const { body, headers } = await new Promise((resolve, reject) => {
      const url = `http://127.0.0.1:${gateway.actualPort}/html-br?__preview_port=${targetPort}`;
      http
        .get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), headers: res.headers }));
        })
        .on('error', reject);
    });
    // Should NOT contain bridge script (can't decode br)
    assert.ok(!body.includes('__catCafeBridge'), 'should not inject into br-encoded HTML');
    // Content-encoding should be preserved (not stripped)
    assert.equal(headers['content-encoding'], 'br');
  });

  it('does NOT inject into CSS responses', async () => {
    const { text } = await fetchViaGateway('/css');
    assert.ok(!text.includes('__catCafeBridge'), 'should not inject into CSS');
    assert.equal(text, 'body { color: red; }');
  });

  it('does NOT inject into JS responses', async () => {
    const { text } = await fetchViaGateway('/js');
    assert.ok(!text.includes('__catCafeBridge'), 'should not inject into JS');
    assert.equal(text, 'console.log("hi")');
  });
});
