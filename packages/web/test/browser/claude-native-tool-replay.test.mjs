import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const { chromium } = await import(
  process.env.CAT_CAFE_PLAYWRIGHT_MODULE ?? '../../../ppt-forge/node_modules/playwright/index.mjs'
);

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.resolve(webRoot, '../..');
const origin = 'https://claude-w1-replay.test';

for (const capture of [
  { name: 'native', history: 'real', sentinel: 'ACP-W1-SUCCESS-20261013', missing: 'definitely-missing-child' },
  { name: 'sdk', history: 'sdk', sentinel: 'ACP-W1-SDK-AUTHORIZED-SUCCESS-20261013', missing: 'missing.txt' },
]) {
  test(`real ${capture.name} persisted results render in production replay UI and survive refresh`, async () => {
    const historyPath = path.join(workspace, `.cat-cafe/tmp/w1-${capture.history}-history/replay.json`);
    const persisted = await readFile(historyPath, 'utf8');
    const events = JSON.parse(persisted);
    assert.equal(events.filter((e) => e.event.type === 'tool_result').length, 5);
    const result = await build({
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
          input: path.join(webRoot, 'test/browser/fixtures/claude-native-tool-replay.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const bundle = result.output.find((e) => e.type === 'chunk' && e.isEntry);
    assert.ok(bundle);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CAT_CAFE_BROWSER_CHANNEL ? { channel: process.env.CAT_CAFE_BROWSER_CHANNEL } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    const errors = [];
    let diskReads = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin);
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.code });
      if (url.pathname === '/persisted-transcript.json') {
        diskReads++;
        return route.fulfill({
          contentType: 'application/json',
          body: await readFile(historyPath, 'utf8'),
        });
      }
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cats: [] }) });
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    try {
      for (let load = 0; load < 2; load++) {
        if (load) await page.reload();
        else await page.goto(origin);
        const headers = page.getByRole('button', { name: /CLI Output/ });
        await headers.first().waitFor();
        for (const header of await headers.all())
          if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
        await page.getByRole('button', { name: /5 tools \(collapsed\)/ }).click();
        for (const name of ['Read', 'Agent'])
          for (const tool of await page.getByRole('button', { name: new RegExp(name) }).all()) await tool.click();
        const text = await page.locator('main').innerText();
        assert.ok(text.includes(capture.sentinel));
        assert.ok(text.includes(capture.missing));
        assert.match(text, /File does not exist/);
        assert.equal((text.match(/File does not exist\. Note:/g) ?? []).length, 2);
        assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 5);
        assert.match(text, /Agent/);
        assert.match(text, /Failed/i);
      }
      assert.equal(diskReads, 2);
      assert.deepEqual(errors, []);
      const dir = path.join(workspace, `.cat-cafe/tmp/w1-${capture.name}-ui-proof`);
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'native-replay.png'), fullPage: true });
      await writeFile(
        path.join(dir, 'result.json'),
        JSON.stringify(
          {
            evidenceKind: 'production_replay_components_real_persisted_data_isolated_browser',
            capture: capture.name,
            origin,
            workspace,
            diskReads,
            pageErrors: errors,
            fullPlatformEndToEnd: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
    }
  });
}
