import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://file-menu-viewport.test';
const evidence = process.env.F309_FILE_MENU_EVIDENCE_DIR;

async function facts(menu) {
  return menu.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      rect: rect.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
      hits: [
        [rect.left + 4, rect.top + 4],
        [rect.right - 4, rect.bottom - 4],
      ].map(([x, y]) => node.contains(document.elementFromPoint(x, y))),
    };
  });
}

function assertReachable(result) {
  const { rect, viewport, hits } = result;
  assert.ok(rect.left >= 0 && rect.right <= viewport.width, `horizontal reachability: ${JSON.stringify(result)}`);
  assert.ok(rect.top >= 0 && rect.bottom <= viewport.height, `vertical reachability: ${JSON.stringify(result)}`);
  assert.deepEqual(hits, [true, true], 'both corners remain hit-testable above clipped ancestors');
}

/** Shared-owner regressions run in the existing Workspace menu journey without another application server. */
export function registerFileMenuViewportJourneys() {
  describe('F309 common file menu viewport continuity', () => {
    let browser, bundle, css;
    before(async () => {
      const priorCwd = process.cwd();
      let result;
      try {
        process.chdir(webRoot);
        result = await build({
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
      } finally {
        process.chdir(priorCwd);
      }
      const output = Array.isArray(result) ? result.flatMap((entry) => entry.output) : result.output;
      bundle = output.find((entry) => entry.type === 'chunk' && entry.isEntry).code;
      css = output
        .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
        .map((entry) => entry.source)
        .join('\n');
      browser = await chromium.launch({ headless: true });
    });
    after(async () => browser?.close());

    for (const language of ['zh', 'en']) {
      test(`${language} keeps the same focused menu reachable after viewport width and height shrink`, async () => {
        const context = await browser.newContext({
          viewport: { width: 1000, height: 720 },
          permissions: ['clipboard-read', 'clipboard-write'],
        });
        const page = await context.newPage();
        const errors = [],
          unexpected = [],
          observations = [];
        let metadataReads = 0;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) {
            unexpected.push(url.href);
            return route.abort();
          }
          if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
          if (url.pathname === '/api/session')
            return route.fulfill({ json: { userId: 'fixture', csrfToken: 'fixture' } });
          if (url.pathname === '/api/uploads/report.md/file-info') {
            metadataReads++;
            return route.fulfill({
              json: {
                local: true,
                path: '/fixture/report.md',
                filename: 'report.md',
                canOpen: false,
                canReveal: false,
              },
            });
          }
          if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
          if (url.pathname === '/')
            return route.fulfill({
              contentType: 'text/html',
              body: `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;font:14px sans-serif;--cafe-surface:#fffbf6;--cafe-border:#e5dfd5;--cafe-text:#141413}section[aria-label="Uploaded document"]{position:absolute;left:580px;top:610px;width:400px;height:420px;display:flex;justify-content:flex-end;align-items:flex-start;overflow:hidden}${css}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
            });
          unexpected.push(url.href);
          return route.abort();
        });
        try {
          await page.goto(`${origin}/?language=${language}`);
          const host = page.getByRole('region', { name: 'Uploaded document' });
          const trigger = host.locator('button[aria-haspopup="menu"]');
          await trigger.focus();
          await page.keyboard.press('Enter');
          const menu = page.getByRole('menu');
          await menu
            .getByRole('menuitem', { name: language === 'zh' ? '复制路径' : 'Copy path', exact: true })
            .waitFor();
          const originalMenu = await menu.elementHandle();
          const originalFocus = await page.evaluateHandle(() => document.activeElement);
          observations.push(await facts(menu));
          assertReachable(observations.at(-1));
          await host.evaluate((node) => Object.assign(node.style, { left: '0px', top: '12px', width: '320px' }));
          for (const [width, height] of [
            [320, 720],
            [320, 240],
            [1000, 720],
          ]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            observations.push(await facts(menu));
            if (evidence) {
              await mkdir(evidence, { recursive: true });
              await page.screenshot({ path: path.join(evidence, `${language}-${width}-${height}.png`) });
            }
            assertReachable(observations.at(-1));
            assert.equal(await originalMenu.evaluate((node) => node === document.querySelector('[role="menu"]')), true);
            assert.equal(await originalFocus.evaluate((node) => node === document.activeElement), true);
            assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
            assert.equal(metadataReads, 1, 'layout changes do not refetch file metadata');
          }
          await page.keyboard.press('Escape');
          assert.equal(await menu.count(), 0);
          assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
          await page.setViewportSize({ width: 320, height: 240 });
          await page.keyboard.press('Enter');
          await menu.getByRole('menuitem', { name: language === 'zh' ? '复制路径' : 'Copy path', exact: true }).click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '/fixture/report.md');
          assert.equal(await menu.count(), 0);
          assert.deepEqual(errors, []);
          assert.deepEqual(unexpected, []);
        } finally {
          if (evidence) {
            await mkdir(evidence, { recursive: true });
            await writeFile(
              path.join(evidence, `${language}.json`),
              JSON.stringify({ observations, metadataReads, errors, unexpected }, null, 2),
            );
          }
          await context.close();
        }
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  registerFileMenuViewportJourneys();
