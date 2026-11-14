import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://windows-files.test';
const absolutePath = `C:\\demo\\${'long directory with spaces\\'.repeat(4)}${'a'.repeat(180)}\\report.md`;
let browser, bundle, css;
before(async () => {
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(webRoot, 'src') } },
    define: {
      'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin),
      'process.env.NODE_ENV': JSON.stringify('test'),
    },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/windows-file-actions.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
  css = outputs
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

for (const width of [360, 1280]) {
  test(`chat and upload file menus recover from failure and contain a long Windows path at ${width}px`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let reads = 0;
    await page.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (url.pathname.endsWith('/file-info')) {
        reads++;
        return route.fulfill({
          status: reads === 1 ? 503 : 200,
          json:
            reads === 1
              ? { error: 'unavailable' }
              : {
                  local: true,
                  path: absolutePath,
                  filename: 'report.md',
                  mime: 'text/markdown',
                  canOpen: false,
                  canReveal: false,
                },
        });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { userId: 'fixture', csrfToken: 'fixture' } });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:16px;font:14px sans-serif;--cafe-surface:#fffbf6;--cafe-surface-elevated:#fcf7f0;--cafe-border:#e5dfd5;--cafe-text:#141413;--cafe-text-muted:#5f5d57;--cafe-accent:#b05f45}main{max-width:600px}section{margin-top:24px}${css}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto(origin);
    assert.equal(await page.locator('[data-chat-file-name]').textContent(), 'report.md');
    await page.locator('[data-chat-reference-kind="file"]').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await menu.getByRole('alert').waitFor();
    assert.match(await menu.getByRole('alert').textContent(), /Could not read file information/);
    assert.doesNotMatch(await menu.textContent(), /Reading file information/);
    await menu.getByRole('button', { name: 'Retry', exact: true }).click();
    await menu.getByRole('menuitem', { name: 'Copy path', exact: true }).waitFor();
    assert.equal(await menu.locator('strong').textContent(), 'report.md');
    assert.match(await menu.textContent(), /Local open and reveal are unavailable/);
    assert.equal(await menu.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const artifacts = path.join(webRoot, '../../artifacts/issue1792');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, `windows-menu-${width}.png`) });
    await menu.getByRole('menuitem', { name: 'Copy path', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), absolutePath);
    await page.getByRole('region', { name: 'Uploaded document' }).getByRole('button').click();
    await menu.getByRole('menuitem', { name: 'Copy path', exact: true }).waitFor();
    await menu.getByRole('menuitem', { name: 'Copy path', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), absolutePath);
    reads = 0;
    await page.goto(`${origin}/?classic=1`);
    const classic = page.getByRole('region', { name: 'Classic file toolbar' });
    await classic.getByRole('alert').waitFor();
    assert.match(await classic.getByRole('alert').textContent(), /Could not read file information/);
    assert.equal(await page.getByRole('menu').count(), 0);
    await classic.getByRole('button', { name: 'Retry', exact: true }).click();
    await classic.getByRole('button', { name: 'Copy path', exact: true }).click();
    assert.equal(await classic.getByRole('alert').count(), 0);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), absolutePath);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
