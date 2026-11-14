import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test(
  'shared Home viewer keeps focus through gallery replacement and explicit owner handoff',
  { timeout: 120_000 },
  async (t) => {
    let bundle = '',
      css = '';
    const calls = [],
      errors = [],
      rows = [];
    const artifacts = ['原图', '第二张', '最后一张'].map((name, index) => ({
      type: 'image',
      name,
      catId: 'codex61-sol',
      createdAt: 1000 - index,
      sourceMessageId: `focus-message-${index}`,
      url: `/uploads/focus-${index}.png`,
      publicationItem: { kind: 'content-block', index: 0 },
    }));
    const server = createServer(async (req, res) => {
      if (req.url === '/host.js' || req.url === '/host.css') {
        res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
        return res.end(req.url.endsWith('.js') ? bundle : css);
      }
      if (req.url.startsWith('/uploads/')) {
        res.setHeader('content-type', 'image/png');
        return res.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
            'base64',
          ),
        );
      }
      if (req.url.startsWith('/api/')) {
        calls.push({ method: req.method, path: req.url });
        let body = {};
        if (req.url === '/api/session') body = { csrfToken: 'isolated-fixture', userId: 'operator' };
        else if (req.url === '/api/cats')
          body = { cats: [{ id: 'codex61-sol', displayName: '小太阳', carrier: 'cli' }] };
        else if (req.url === '/api/config/cat-order') body = { catOrder: [] };
        else if (req.url.endsWith('/artifacts?view=works'))
          body = { artifacts, total: 3, view: 'works', complete: true, workLineage: 'resolved' };
        else if (req.url === '/api/content-publications/resolve') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const { source } = JSON.parse(raw);
          const index = artifacts.findIndex((item) => item.url === source.expectedUrl);
          assert.ok(index >= 0, 'admission must refer to one original fixture publication');
          body = {
            status: 'resolved',
            ownerUserId: 'operator',
            asset: {
              contentRef: `prepared-media:${String(index + 1).repeat(64)}`,
              ownerRevision: 1,
              blobDigest: `sha256:${String(index + 1).repeat(64)}`,
              mediaType: 'image/png',
              media: { kind: 'image', width: 480, height: 240 },
              ownerReceiptRef: `receipt-${index}`,
              sourcePublication: {
                artifactRef: source.expectedUrl,
                sourceRef: `message:${source.threadId}:${source.messageId}`,
                revision: source.messageRevision,
              },
            },
          };
        } else body = { items: [], sessions: [], total: 0 };
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(body));
      }
      if (req.url !== '/') {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><div id="root"></div><script type="module" src="/host.js"></script></html>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await build({
      root: web,
      configFile: false,
      logLevel: 'error',
      esbuild: { jsx: 'automatic' },
      resolve: {
        alias: {
          '@/components/workbench/F307OwnerSurfaceRenderer': path.join(
            web,
            'test/browser/fixtures/artwork-focus-owner.tsx',
          ),
          '@': path.join(web, 'src'),
        },
      },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(web, 'test/browser/fixtures/artwork-focus.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    bundle = output.find((item) => item.type === 'chunk' && item.isEntry).code;
    css = output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    const evidence = process.env.F309_FOCUS_EVIDENCE;
    if (evidence) await mkdir(evidence, { recursive: true });
    t.after(async () => {
      try {
        if (!evidence) return;
        await writeFile(
          path.join(evidence, 'diagnostics.json'),
          JSON.stringify({ calls, errors, rows, text: await page.locator('body').innerText() }, null, 2),
        );
        await page.screenshot({ path: path.join(evidence, 'last.png') });
      } finally {
        await browser.close();
      }
    });
    await page.goto(origin);
    const cards = page.locator('button[data-home-artifact-id]');
    await cards.first().waitFor();
    await page.evaluate(() => {
      window.originalComposer = document.querySelector('[data-testid="original-composer"]');
      window.originalCard = document.querySelector('button[data-home-artifact-id]');
    });
    const observe = async (scenario, passed) => {
      const focus = await page.evaluate(() => ({
        label:
          document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('data-testid'),
        inDialog: !!document.querySelector('[role="dialog"]')?.contains(document.activeElement),
        body: document.activeElement === document.body,
        disabled: document.activeElement?.matches(':disabled'),
        composerSame: document.querySelector('[data-testid="original-composer"]') === window.originalComposer,
        draft: window.originalComposer.value,
      }));
      rows.push({ scenario, passed, focus });
      if (evidence) await page.screenshot({ path: path.join(evidence, `${scenario}.png`) });
    };
    const inDialog = () =>
      page.evaluate(
        () =>
          !!document.querySelector('[role="dialog"]')?.contains(document.activeElement) &&
          !document.activeElement.matches(':disabled'),
      );
    const pagingFocus = (direction) =>
      page.evaluate(
        (value) => document.activeElement?.getAttribute('data-artwork-gallery-direction') === value,
        direction,
      );
    const selectedFocus = () =>
      page.evaluate(() =>
        document.activeElement?.matches('[data-testid="artwork-gallery-thumbnails"] [aria-current="true"]'),
      );
    const open = async () => {
      await cards.first().click();
      await page.getByTestId('fixture-admitted-owner').waitFor({ state: 'attached', timeout: 5000 });
      await page.getByRole('button', { name: '下一件作品', exact: true }).waitFor();
    };
    await open();
    await page.getByTestId('other-owner').focus();
    await page.keyboard.press('Escape');
    await observe(
      'connected-opener-other-owner',
      await page.getByTestId('other-owner').evaluate((node) => document.activeElement === node),
    );

    await open();
    for (const index of [1, 2]) {
      if (index === 1) await page.getByRole('button', { name: '下一件作品', exact: true }).click();
      else await page.keyboard.press('Space');
      await page.waitForFunction(
        (url) => document.querySelector('[data-testid="artwork-chat-preview"] img')?.getAttribute('src')?.endsWith(url),
        artifacts[index].url,
      );
      await observe(
        `next-${index}`,
        (await inDialog()) && (index === 1 ? await pagingFocus('next') : await selectedFocus()),
      );
    }
    await page.keyboard.press('Tab');
    await observe('tab-after-last', await inDialog());
    for (const index of [1, 0]) {
      await page.getByRole('button', { name: '上一件作品', exact: true }).click();
      await page.waitForFunction(
        (url) => document.querySelector('[data-testid="artwork-chat-preview"] img')?.getAttribute('src')?.endsWith(url),
        artifacts[index].url,
      );
      await observe(
        `previous-${index}`,
        (await inDialog()) && (index === 1 ? await pagingFocus('previous') : await selectedFocus()),
      );
    }
    await page.keyboard.press('Escape');
    await observe('normal-close-origin', await page.evaluate(() => document.activeElement === window.originalCard));
    await open();
    await page.getByTestId('other-owner').focus();
    const urlBefore = await page.locator('[data-testid="artwork-chat-preview"] img').getAttribute('src');
    await page.keyboard.press('ArrowRight');
    await observe(
      'other-owner-arrow',
      (await page.getByTestId('other-owner').evaluate((node) => document.activeElement === node)) &&
        (await page.locator('[data-testid="artwork-chat-preview"] img').getAttribute('src')) === urlBefore,
    );
    await page.keyboard.press('Escape');
    await open();
    await page.getByRole('button', { name: '下一件作品', exact: true }).focus();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-present-owner')));
    await page.getByTestId('artwork-chat-preview').waitFor({ state: 'detached' });
    await observe('preview-owner-handoff', (await inDialog()) && (await selectedFocus()));
    await page.keyboard.press('Shift+Tab');
    await observe('tab-after-owner-handoff', await inDialog());
    await page.keyboard.press('Escape');
    await open();
    await page.getByRole('button', { name: '下一件作品', exact: true }).focus();
    await page.getByTestId('other-owner').focus();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-present-owner')));
    await page.getByTestId('artwork-chat-preview').waitFor({ state: 'detached' });
    await observe(
      'handoff-respects-other-owner',
      await page.getByTestId('other-owner').evaluate((node) => document.activeElement === node),
    );
    await page.keyboard.press('Escape');
    if (evidence)
      await writeFile(
        path.join(evidence, 'result.json'),
        JSON.stringify(
          {
            head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(),
            rows,
            calls,
            errors,
            boundary:
              'Production Home/source admission/scope/Host/preview/gallery/Lightbox and CSS. Isolated HTTP responses and editing renderer boundary; no runtime or persistent application data.',
          },
          null,
          2,
        ),
      );
    assert.deepEqual(errors, []);
    assert.ok(rows.every((row) => row.focus.composerSame && row.focus.draft === '未发送的原草稿'));
    assert.deepEqual(
      rows.filter((row) => !row.passed).map((row) => row.scenario),
      [],
    );
  },
);
