import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tsImport } from 'tsx/esm/api';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { appGlobalCssFiles, syncStylesheets } from '../../scripts/vendor-stylesheets.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const workbox = createRequire(require.resolve('@ducanh2912/next-pwa'))('workbox-build');
Object.assign(globalThis, { React });

test('an old worker cannot pair the updated rail with its cached unversioned CSS, including offline reload', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f322-style-upgrade-'));
  const fixtureWeb = path.join(root, 'web');
  const publicRoot = path.join(fixtureWeb, 'public');
  const oldCss = '/* Previous shell has no shared world-rail layout classes. */';
  const legacyUrl = '/vendor/app/shell-v2.css';
  let upgraded = false;
  let browser;
  let context;
  let server;
  const evidence = [];
  try {
    mkdirSync(path.join(fixtureWeb, 'src/app'), { recursive: true });
    mkdirSync(path.join(root, 'ui/src'), { recursive: true });
    for (const name of appGlobalCssFiles)
      cpSync(path.join(webRoot, 'src/app', name), path.join(fixtureWeb, 'src/app', name));
    cpSync(path.join(webRoot, '../ui/src/styles.css'), path.join(root, 'ui/src/styles.css'));
    const xterm = path.join(webRoot, 'node_modules/@xterm/xterm/css/xterm.css');
    const urls = syncStylesheets(fixtureWeb, xterm);
    const currentCss = readFileSync(path.join(publicRoot, legacyUrl), 'utf8');
    writeFileSync(path.join(publicRoot, legacyUrl), oldCss);
    await workbox.generateSW({
      globDirectory: publicRoot,
      globPatterns: ['vendor/app/shell-v2.css'],
      swDest: path.join(publicRoot, 'sw.js'),
      skipWaiting: true,
      clientsClaim: true,
      mode: 'production',
      runtimeCaching: [
        {
          urlPattern: ({ request }) => request.mode === 'navigate',
          handler: 'NetworkFirst',
          options: { cacheName: 'upgrade-documents' },
        },
        {
          urlPattern: /\.(?:css|less)$/i,
          handler: 'StaleWhileRevalidate',
          options: { cacheName: 'upgrade-style-assets' },
        },
      ],
    });
    const { WorldRailFrame } = await tsImport(
      pathToFileURL(path.join(webRoot, '../ui/src/ShellFrame.tsx')).href,
      import.meta.url,
    );
    const rail = renderToStaticMarkup(
      React.createElement(
        WorldRailFrame,
        { 'data-testid': 'upgrade-rail' },
        React.createElement('span', null, 'Top'),
        React.createElement('button', { id: 'bottom', type: 'button', style: { marginTop: 'auto' } }, 'Bottom'),
      ),
    );
    server = createServer((request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/' || pathname === '/legacy') {
        const links = pathname === '/legacy' ? urls.map((url) => url.replace(/\.[a-f0-9]{16}\.css$/, '.css')) : urls;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(
          `<!doctype html><html data-shell="v2"><head><style>*,::before,::after{box-sizing:border-box}</style>${links.map((url) => `<link rel="stylesheet" href="${url}">`).join('')}</head>` +
            `<body style="margin:0"><main style="height:400px;display:flex">${upgraded ? rail : 'Earlier document'}</main></body></html>`,
        );
        return;
      }
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      const file = path.resolve(publicRoot, `.${pathname}`);
      try {
        if (!file.startsWith(`${publicRoot}${path.sep}`)) throw new Error('Outside fixture root');
        response.writeHead(200, {
          'Content-Type': pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
          'Cache-Control': 'no-store',
        });
        response.end(readFileSync(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 800, height: 500 } });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
        );
    });
    upgraded = true;
    writeFileSync(path.join(publicRoot, legacyUrl), currentCss);
    const measure = () =>
      page.evaluate(() => {
        const rail = document.querySelector('.cafe-world-rail');
        return {
          width: rail.getBoundingClientRect().width,
          display: getComputedStyle(rail).display,
          bottom: document.getElementById('bottom').getBoundingClientRect().top,
          controller: navigator.serviceWorker.controller?.scriptURL,
        };
      });
    await page.goto(`${origin}/legacy`, { waitUntil: 'networkidle' });
    const broken = await measure();
    assert.equal(broken.display, 'block', 'negative control: the old fixed URL still receives stale CSS');
    evidence.push({ stage: 'legacy-negative-control', ...broken });
    await page.goto(origin, { waitUntil: 'networkidle' });
    const fixed = await measure();
    assert.equal(fixed.controller, broken.controller, 'the old worker remains in control');
    assert.equal(fixed.width, 52);
    assert.equal(fixed.display, 'flex');
    assert.ok(fixed.bottom > 350);
    const stale = await page.evaluate(async (url) => (await fetch(url)).text(), legacyUrl);
    assert.equal(stale, oldCss, 'the repair must work while the incompatible old cache still exists');
    const loaded = await page.evaluate(async () =>
      Promise.all(
        [...document.querySelectorAll('link[rel="stylesheet"]')].map(async (link) => ({
          url: new URL(link.href).pathname,
          css: await (await fetch(link.href)).text(),
        })),
      ),
    );
    for (const { url, css } of loaded)
      assert.ok(url.endsWith(`.${createHash('sha256').update(css).digest('hex').slice(0, 16)}.css`));
    evidence.push({ stage: 'versioned-online', ...fixed, stylesheetCount: loaded.length });
    await page.waitForFunction(async () => (await (await caches.open('upgrade-style-assets')).keys()).length >= 10);
    await context.setOffline(true);
    await page.reload({ waitUntil: 'networkidle' });
    const offline = await measure();
    assert.equal(offline.width, 52);
    assert.equal(offline.display, 'flex');
    assert.ok(offline.bottom > 350);
    evidence.push({ stage: 'versioned-offline', ...offline });
    if (process.env.STYLE_UPGRADE_EVIDENCE_DIR) {
      mkdirSync(process.env.STYLE_UPGRADE_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.STYLE_UPGRADE_EVIDENCE_DIR, 'upgrade.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      await page.screenshot({ path: path.join(process.env.STYLE_UPGRADE_EVIDENCE_DIR, 'upgraded-rail.png') });
    }
  } finally {
    await context?.close();
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
