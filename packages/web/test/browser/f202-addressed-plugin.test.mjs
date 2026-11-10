import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { build } from 'vite';

const { chromium } = await import(
  process.env.F202_PLAYWRIGHT_MODULE ?? '../../../ppt-forge/node_modules/playwright/index.mjs'
);

import { createHash } from 'node:crypto';
import { MemoryPluginInventoryStore } from '../../../api/dist/domains/plugin/host-inventory/stores.js';
import { PluginAddressedTargets } from '../../../api/dist/domains/plugin/manager/addressing/plugin-addressed-targets.js';
import { registerPluginManagerRoutes } from '../../../api/dist/routes/plugin-manager-routes.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(webRoot, 'package.json'));
const tailwind = require('tailwindcss');
const tailwindConfig = require(path.join(webRoot, 'tailwind.config.js'));

test(
  'plugin mentions, preview, acceptance and address editing use existing Host surfaces',
  { timeout: 120000 },
  async () => {
    const evidence = await mkdtemp(path.join(tmpdir(), 'f202-addressed-ui-'));
    const digest = `sha512-${createHash('sha512').update('browser-fixture').digest('base64')}`;
    const manifest = JSON.parse(
      await readFile(
        new URL(
          '../../../api/src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.52/manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const inventory = new MemoryPluginInventoryStore({
      schemaVersion: 1,
      packages: [
        {
          packageDigest: digest,
          pluginId: 'example.dot',
          version: '1.0.0',
          contractVersion: manifest.contractVersion,
          manifest: {
            ...manifest,
            pluginId: 'example.dot',
            version: '1.0.0',
            name: 'Dot',
            call: { alias: 'dot', displayName: 'Dot' },
          },
          signalSchemas: {},
          packageState: 'installed',
          verifiedAt: 1,
          updatedAt: 1,
        },
      ],
      instances: [
        {
          pluginInstanceId: 'pi_dot',
          pluginId: 'example.dot',
          packageDigest: digest,
          lifecycleState: 'installed',
          configReadiness: 'ready',
          activationState: 'enabled',
          runtimeState: 'healthy',
          lifecycleRevision: 1,
          installedAt: 1,
          updatedAt: 1,
        },
      ],
      grants: [
        {
          pluginInstanceId: 'pi_dot',
          requestedCapabilities: [],
          effectiveGrants: [],
          grantRevision: 1,
          updatedAt: 1,
        },
      ],
    });
    const addressedTargets = new PluginAddressedTargets({ inventory, memberAliases: () => ['opus'] });
    assert.equal((await addressedTargets.resolve('@dot'))?.id, 'pi_dot');
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
    });
    registerPluginManagerRoutes(app, {
      addressedTargets,
      manager: { list: async () => ({ plugins: [], catalog: { status: 'fresh' } }) },
      auditLog: { append: async () => {} },
    });
    let script = '',
      css = '';
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"></head><body><div id="root"></div><script type="module" src="/proof.js"></script></body></html>',
        ),
    );
    app.get('/proof.js', async (_req, reply) => reply.type('text/javascript').send(script));
    app.get('/proof.css', async (_req, reply) => reply.type('text/css').send(css));
    app.get('/api/cats', async () => ({ cats: [] }));
    app.get('/api/config/cat-order', async () => ({ order: [] }));
    app.get('/api/session', async () => ({
      userId: process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user',
      csrfToken: 'browser-fixture',
    }));
    let browser;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const built = await build({
        root: webRoot,
        configFile: false,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        css: {
          postcss: {
            plugins: [
              tailwind({
                ...tailwindConfig,
                content: [
                  path.join(webRoot, 'src/**/*.{ts,tsx}'),
                  path.join(webRoot, 'test/browser/fixtures/f202-addressed-plugin.tsx'),
                ],
              }),
            ],
          },
        },
        resolve: { alias: { '@': path.join(webRoot, 'src') } },
        define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(app.listeningOrigin) },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: path.join(webRoot, 'test/browser/fixtures/f202-addressed-plugin.tsx'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
      const output = built.output;
      script = output.find((x) => x.type === 'chunk' && x.isEntry).code;
      css = output
        .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
        .map((x) => x.source)
        .join('\n');
      browser = await chromium.launch({
        headless: true,
        ...(process.env.F202_BROWSER_EXECUTABLE ? { executablePath: process.env.F202_BROWSER_EXECUTABLE } : {}),
      });
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        console.log('Browser request failed', url.origin, url.pathname, request.failure()?.errorText);
      });
      page.on('response', (response) => {
        if (response.status() >= 400) console.log('HTTP failure', response.status(), response.url());
      });
      await page.goto(app.listeningOrigin, { waitUntil: 'networkidle' });
      await page
        .getByLabel('插件别名', { exact: true })
        .waitFor({ timeout: 10000 })
        .catch(async (error) => {
          console.log('Browser diagnostics', errors, await page.locator('body').innerText());
          throw error;
        });
      assert.match(await page.getByTestId('composer-routing-preview').getAttribute('aria-label'), /dot/);
      assert.equal(await page.getByTestId('message-dispatch-avatars').textContent(), 'dot已接收');
      assert.equal(await page.getByTestId('message-dispatch-avatars').getByRole('button').count(), 0);
      await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });
      await page.getByLabel('插件别名', { exact: true }).fill('opus');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByLabel('插件别名', { exact: true }).inputValue(), 'opus');
      await page.getByLabel('插件别名', { exact: true }).fill('helper');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      assert.equal((await addressedTargets.resolve('@helper')).id, 'pi_dot');
      assert.equal((await inventory.snapshot()).instances[0].lifecycleRevision, 1);
      await page.getByRole('button', { name: '@helper 插件 · Dot', exact: false }).click();
      assert.equal(await page.getByTestId('inserted').textContent(), '@helper ');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.getByLabel('插件别名', { exact: true }).inputValue(), 'helper');
      assert.match(await page.getByTestId('message-dispatch-avatars').textContent(), /helper已接收/);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(evidence, 'mobile-dark.png'), fullPage: true });
      assert.deepEqual(errors, []);
      console.log(`F202 addressed UI evidence: ${evidence}`);
    } finally {
      await browser?.close();
      await app.close();
    }
  },
);
