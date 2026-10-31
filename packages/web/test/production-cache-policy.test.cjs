const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const next = require('next');

const WEB_ROOT = path.resolve(__dirname, '..');
const SERVICE_WORKER_PATH = path.join(WEB_ROOT, 'public', 'sw.js');
const PRERENDER_MANIFEST_PATH = path.join(WEB_ROOT, '.next', 'prerender-manifest.json');
const CHAT_DOCUMENT_ROUTES = ['/', '/thread/pwa-cache-policy-probe'];

function readProductionArtifacts() {
  assert.ok(fs.existsSync(SERVICE_WORKER_PATH), 'run the production Web build before this test (missing public/sw.js)');
  assert.ok(
    fs.existsSync(PRERENDER_MANIFEST_PATH),
    'run the production Web build before this test (missing .next/prerender-manifest.json)',
  );

  return {
    serviceWorker: fs.readFileSync(SERVICE_WORKER_PATH, 'utf8'),
    prerenderManifest: JSON.parse(fs.readFileSync(PRERENDER_MANIFEST_PATH, 'utf8')),
  };
}

function readCacheControl(response) {
  const raw = response.headers.get('cache-control');
  assert.ok(raw, `${response.url} must publish Cache-Control`);
  return new Set(raw.split(',').map((directive) => directive.trim().toLowerCase()));
}

function findHashedChunkUrl(serviceWorker) {
  const match = serviceWorker.match(/url:"(\/_next\/static\/chunks\/[^"?]+\.[a-f0-9]{8,}\.js)"/);
  assert.ok(match, 'the generated service worker must retain content-hashed JavaScript chunks');
  return match[1];
}

describe('production PWA cache policy', () => {
  const artifacts = readProductionArtifacts();
  let app;
  let server;
  let origin;

  before(async () => {
    app = next({ dev: false, dir: WEB_ROOT, hostname: '127.0.0.1', port: 0 });
    await app.prepare();
    server = http.createServer(app.getRequestHandler());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (app) await app.close();
  });

  it('keeps build-specific chat documents out of static output and the precache manifest', () => {
    assert.equal(
      artifacts.prerenderManifest.routes['/'],
      undefined,
      'the root chat document must be rendered per request, not emitted as a long-lived static route',
    );
    assert.doesNotMatch(
      artifacts.serviceWorker,
      /(?:^|[{,])url:"\/",revision:/,
      'the service worker must not precache the build-specific root document',
    );
    assert.match(
      artifacts.serviceWorker,
      /registerRoute\("\/",new [\w$.]+\.NetworkFirst\(\{cacheName:"start-url"/,
      'the start document must retain NetworkFirst runtime caching for offline fallback',
    );
    findHashedChunkUrl(artifacts.serviceWorker);
  });

  it('serves documents as non-cacheable while keeping hashed assets immutable', async () => {
    for (const route of CHAT_DOCUMENT_ROUTES) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200, route);
      const cacheControl = readCacheControl(response);
      for (const directive of ['private', 'no-cache', 'no-store', 'max-age=0', 'must-revalidate']) {
        assert.ok(cacheControl.has(directive), `${route} must publish ${directive}`);
      }
      assert.equal(
        [...cacheControl].some((directive) => directive.startsWith('s-maxage=')),
        false,
        `${route} must not publish a shared-cache lifetime`,
      );
    }

    const chunkUrl = findHashedChunkUrl(artifacts.serviceWorker);
    const chunkResponse = await fetch(`${origin}${chunkUrl}`);
    assert.equal(chunkResponse.status, 200, chunkUrl);
    const chunkCacheControl = readCacheControl(chunkResponse);
    assert.ok(chunkCacheControl.has('public'));
    assert.ok(chunkCacheControl.has('max-age=31536000'));
    assert.ok(chunkCacheControl.has('immutable'));
  });
});
