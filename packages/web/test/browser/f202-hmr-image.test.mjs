import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { build } from 'vite';
import { FileMessagingMediaLedger } from '../../../api/dist/domains/messaging/media-ledger.js';
import { sessionAuthPlugin, sessionRoute } from '../../../api/dist/infrastructure/session-auth.js';
import { mediaRoutes } from '../../../api/dist/routes/media-routes.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(
  process.env.F202_PLAYWRIGHT_MODULE ?? '../../../ppt-forge/node_modules/playwright/index.mjs'
);
const imageBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="140"><rect width="220" height="140" fill="#7c3aed"/><circle cx="110" cy="70" r="44" fill="#facc15"/></svg>',
);

test(
  'real plugin bubble renders owner-authenticated HMR image and stable missing placeholder',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'f202-e3-browser-'));
    const ledger = new FileMessagingMediaLedger(path.join(root, 'media'));
    const good = await ledger.register(imageBytes, { mimeType: 'image/svg+xml' });
    const missing = `hmr_${'A'.repeat(32)}`;
    const app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: 'owner-user' });
    await app.register(mediaRoutes, { ledger, ownerUserId: 'owner-user' });
    let bundleCode = '';
    app.get('/', async (_, reply) =>
      reply
        .type('text/html')
        .send(
          `<!doctype html><html><body data-good="${good}" data-missing="${missing}"><div id="root"></div><script type="module" src="/proof.js"></script></body></html>`,
        ),
    );
    app.get('/proof.js', async (_, reply) => reply.type('text/javascript').send(bundleCode));
    await app.listen({ host: '127.0.0.1', port: 0 });
    let browser;
    try {
      const origin = app.listeningOrigin;
      const built = await build({
        root: webRoot,
        configFile: false,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        resolve: { alias: { '@': path.join(webRoot, 'src') } },
        define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: path.join(webRoot, 'test/browser/fixtures/f202-hmr-image.tsx'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
      const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
      const bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry);
      assert(bundle?.type === 'chunk');
      bundleCode = bundle.code;
      browser = await chromium.launch({
        headless: true,
        ...(process.env.F202_BROWSER_EXECUTABLE ? { executablePath: process.env.F202_BROWSER_EXECUTABLE } : {}),
      });
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const mediaRequests = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/media/hmr/')) mediaRequests.push(request.url());
      });
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.locator('img[src^="blob:"]').waitFor();
      assert.equal(await page.locator('img[src^="hmr:"]').count(), 0);
      assert.equal(await page.locator('img[src^="blob:"]').evaluate((image) => image.naturalWidth), 220);
      await page.getByText('图片暂不可用').waitFor();
      await page.locator('img[src^="blob:"]').first().click();
      assert.equal(await page.getByRole('dialog', { name: 'attachment' }).locator('img[src^="blob:"]').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(mediaRequests.length, 2);
      assert(mediaRequests.every((url) => url.startsWith(`${origin}/api/media/hmr/`)));
      await page.screenshot({ path: path.join(root, 'owner-image-and-placeholder.png'), fullPage: true });
      const nonOwnerContext = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.2' } });
      const nonOwnerPage = await nonOwnerContext.newPage();
      await nonOwnerPage.goto(origin, { waitUntil: 'networkidle' });
      await nonOwnerPage.getByText('图片暂不可用').first().waitFor();
      assert.equal(await nonOwnerPage.locator('img[src^="blob:"]').count(), 0);
      await nonOwnerPage.screenshot({ path: path.join(root, 'non-owner-placeholder.png'), fullPage: true });
      await nonOwnerContext.close();
      const offlinePage = await browser.newPage();
      await offlinePage.route('**/api/media/hmr/*', (route) => route.abort('failed'));
      await offlinePage.goto(origin, { waitUntil: 'networkidle' });
      await offlinePage.getByText('图片暂不可用').first().waitFor();
      assert.equal(await offlinePage.locator('img[src^="blob:"]').count(), 0);
      await offlinePage.screenshot({ path: path.join(root, 'network-placeholder.png'), fullPage: true });
      await offlinePage.close();
      assert.equal((await app.inject({ method: 'GET', url: `/uploads/${good}` })).statusCode, 404);
      process.stdout.write(`F202 e3 browser evidence: ${root}\n`);
    } finally {
      await browser?.close();
      await app.close();
    }
  },
);
