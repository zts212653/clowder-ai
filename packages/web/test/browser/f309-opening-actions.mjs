import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';
import { createOpeningFileServer } from './f309-opening-actions-file-server.mjs';
import {
  createReviewState,
  fixtureForApi,
  reviewView,
  WORKTREE_ID,
} from './f309-ordinary-workspace-journey-fixture.mjs';

const require = createRequire(import.meta.url);
const { build } = await import(require.resolve('vite', { paths: [require.resolve('vitest/package.json')] }));
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.env.F309_ACTIONS_EVIDENCE;
assert.ok(evidence);
await mkdir(evidence, { recursive: true });
const map =
  process.env.F309_ACTIONS_IMAGE ??
  path.resolve(web, '../../docs/plans/assets/memory-delivery-roadmap/construction-map.png');
const bytes = await readFile(map);
const filePath = 'docs/plans/assets/memory-delivery-roadmap/construction-map.png';
const digest = createHash('sha256').update(bytes).digest('hex');
const fixture = {
  filePath,
  fileName: 'construction-map.png',
  bytes,
  revision: `sha256:${digest}`,
  mime: 'image/png',
  media: { kind: 'image', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
};
const origin = 'http://localhost:5162';
const fileServer = await createOpeningFileServer({
  repo: path.resolve(web, '../..'),
  image: map,
  filePath,
  worktreeIds: ['listed-root', WORKTREE_ID, canonicalWorktreeId(WORKTREE_ID)],
});
const previous = process.cwd();
let built;
try {
  process.chdir(web);
  built = await build({
    root: web,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: 'next/navigation', replacement: path.join(web, 'test/browser/fixtures/f322-shell-navigation.ts') },
        { find: '@', replacement: path.join(web, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(web, 'test/browser/fixtures/f309-opening-actions.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
} finally {
  process.chdir(previous);
}
const outputs = (Array.isArray(built) ? built : [built]).flatMap((v) => v.output);
const script = outputs.find((v) => v.type === 'chunk' && v.isEntry).code;
const css = outputs
  .filter((v) => v.type === 'asset' && v.fileName.endsWith('.css'))
  .map((v) => v.source)
  .join('\n');
const browser = await chromium.launch({ headless: true });
const result = {
  kind: 'production-components-real-file-actions-controlled-review-owner',
  imageSha256: digest,
  media: fixture.media,
  cases: [],
  errors: [],
};
try {
  for (const language of ['zh', 'en']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    page.on('pageerror', (error) => result.errors.push(error.message));
    const state = createReviewState(fixture);
    const before = JSON.stringify(state);
    const calls = [];
    let release;
    const ownerGate = new Promise((resolve) => {
      release = resolve;
    });
    let slow = true;
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
        });
      if (/\/(file-info|reveal|open)$/.test(url.pathname)) {
        const { response, executed } = await fileServer.inject(url, request.method());
        if (request.method() === 'POST')
          calls.push({ path: url.pathname, executed, method: request.method(), status: response.statusCode });
        return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      }
      if (url.pathname === '/api/workspace/file/raw' || url.pathname.endsWith('/media'))
        return route.fulfill({ contentType: fixture.mime, body: bytes });
      if (url.pathname.startsWith('/api/')) {
        if (
          slow &&
          [
            '/api/workspace/file',
            '/api/workspace/resolve-file-source',
            '/api/workspace/content-reviews/prepare',
          ].includes(url.pathname)
        )
          await ownerGate;
        let value = fixtureForApi(url, 'filename', state);
        if (url.pathname === '/api/workspace/resolve-file-source')
          value = { kind: 'file', worktreeId: canonicalWorktreeId(WORKTREE_ID), path: filePath };
        if (url.pathname.startsWith('/api/workspace/content-reviews')) value = reviewView(state);
        if (url.pathname === '/api/content-modifications/context') value = { requests: [] };
        if (url.pathname === '/api/workspace/chat-references') value = { groups: [] };
        return route.fulfill({ json: value });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${origin}/?language=${language}`);
    await page.locator('main img').evaluate((img) => img.decode());
    await page.evaluate(() => {
      window.originalComposer = document.querySelector('textarea');
    });
    await page.locator('main button[aria-label^="打开作品"],main button[aria-label^="Open artwork"]').click();
    const preview = page.getByTestId('artwork-chat-preview');
    await preview.waitFor();
    const more = page.getByRole('button', {
      name: language === 'zh' ? '作品更多操作' : 'More artwork actions',
      exact: true,
    });
    await more.click();
    const reveal = page.getByRole('menuitem', {
      name: language === 'zh' ? '在 Finder 中显示' : 'Show in Finder',
      exact: true,
    });
    await reveal.waitFor();
    await page.screenshot({ path: path.join(evidence, `pending-${language}.png`) });
    await page.getByRole('menuitem', { name: language === 'zh' ? '复制路径' : 'Copy path', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.resolve(map));
    await more.click();
    const revealed = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/reveal') && response.request().method() === 'POST',
    );
    await reveal.click();
    assert.equal((await revealed).status(), 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].status, 200, 'the real file-action route must admit the PNG Finder operation');
    await page.keyboard.press('Meta+c');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('output')].some((node) =>
          /已复制图片|Image copied|操作未完成|failed/i.test(node.textContent ?? ''),
        ),
      null,
      { timeout: 5000 },
    );
    const clip = await page.evaluate(async () => {
      const data = await navigator.clipboard.read();
      return data.flatMap((x) => x.types);
    });
    assert.ok(clip.includes('image/png'), 'copy shortcut must copy the visible preview pixels');
    if (language === 'zh') await page.getByRole('button', { name: '下载', exact: true }).focus();
    else await page.getByRole('textbox', { name: 'original composer', exact: true }).focus();
    slow = false;
    release();
    await preview.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByTestId('workspace-content-review-media').evaluate((img) => img.decode());
    assert.equal(await more.count(), 1);
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
    if (language === 'en') {
      assert.equal(await page.evaluate(() => document.activeElement === window.originalComposer), true);
      await page.evaluate(() => navigator.clipboard.writeText('composer shortcut sentinel'));
      await page.keyboard.press('Meta+c');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'composer shortcut sentinel');
      await more.focus();
    } else {
      const actions = page.getByRole('group', { name: '作品更多操作', exact: true });
      assert.equal(await actions.evaluate((el) => document.activeElement === el), true);
    }
    await page.evaluate(() => navigator.clipboard.writeText('clipboard before owner shortcut'));
    await page.keyboard.press('Meta+c');
    await page.waitForFunction(async () =>
      (await navigator.clipboard.read()).some((item) => item.types.includes('image/png')),
    );
    await page.screenshot({ path: path.join(evidence, `handoff-${language}.png`) });
    await more.click();
    await reveal.waitFor();
    await page.screenshot({ path: path.join(evidence, `owner-${language}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 1, 'Escape closes only the menu first');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.querySelector('textarea') === window.originalComposer), true);
    assert.equal(await page.getByRole('textbox').inputValue(), '原草稿不能丢');
    assert.equal(JSON.stringify(state), before);
    result.cases.push({
      language,
      previewActions: true,
      copyPath: true,
      revealConsumer: true,
      copyPixelsShortcut: true,
      handoffFocus: language === 'zh' ? 'download' : 'original composer',
      handoffFocusPreserved: true,
      singleOwnerActions: true,
      escapeAndOriginalDraft: true,
      ledgerUnchanged: true,
      calls,
    });
    await page.close();
  }
  assert.deepEqual(result.errors, []);
  assert.equal(
    createHash('sha256')
      .update(await readFile(map))
      .digest('hex'),
    digest,
    'source changed during verification',
  );
  result.status = 'pass';
} catch (error) {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .at(-1);
  if (page) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    result.dom = await page.locator('body').innerText();
    result.focus = await page.evaluate(() => document.activeElement?.outerHTML);
  }
  result.status = 'fail';
  result.failure = error.stack;
  process.exitCode = 1;
} finally {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await browser.close();
  await fileServer.close();
  console.log(JSON.stringify(result));
}
