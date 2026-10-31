import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';
import { installFirstFrameProbe } from './f309-open-latency-frame.mjs';
import {
  createReviewState,
  fixtureForApi,
  reviewView,
  WORKTREE_ID,
} from './f309-ordinary-workspace-journey-fixture.mjs';

const require = createRequire(import.meta.url);
const { build } = await import(require.resolve('vite', { paths: [require.resolve('vitest/package.json')] }));
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(web, '../..');
const evidence = process.env.F309_OPEN_EVIDENCE;
assert.ok(evidence, 'F309_OPEN_EVIDENCE must name this run’s evidence directory');
await mkdir(evidence, { recursive: true });
const driverSha256 = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
const previous = process.cwd();
let built;
try {
  process.chdir(web);
  const fixtureRoot = path.join(web, 'test/browser/fixtures');
  built = await build({
    root: web,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: 'next/navigation', replacement: path.join(fixtureRoot, 'f322-shell-navigation.ts') },
        { find: '@', replacement: path.join(web, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('https://f309-open.test') },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(fixtureRoot, 'f309-open-latency.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
} finally {
  process.chdir(previous);
}
const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
const script = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
const css = outputs
  .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
  .map((item) => item.source)
  .join('\n');
if (process.argv.includes('--compile-only')) {
  await writeFile(
    path.join(evidence, 'compile.json'),
    JSON.stringify({ scriptBytes: script.length, cssBytes: css.length }),
  );
  process.exit(0);
}
const image = await readFile(path.join(repo, 'docs/evidence/2026-10-15-f322-journey6-find/shots/j6-1-find.jpg'));
const filmPath = process.env.F309_OPEN_FILM;
assert.ok(filmPath, 'F309_OPEN_FILM must name the original cat-planet v1.2 file');
const movie = await readFile(filmPath);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(image), 'b4a35e48d257a9f7b6573bef0eb33d3890ac9c5d0292a57fe45badb1fab521b8');
assert.equal(hash(movie), '823ba4acf283d6eb2929a1e1e7837e6f4a393875bc94e6e7f135de47f99d47de');
const browser = await chromium.launch({ headless: true });
const results = [],
  errors = [];
try {
  for (const video of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    const bytes = video ? movie : image,
      name = video ? 'cat-planet-trailer-v1.2-1080p.mp4' : 'j6-1-find.jpg';
    const fixture = {
      fileName: name,
      filePath: name,
      bytes,
      revision: `sha256:${hash(bytes)}`,
      mime: video ? 'video/mp4' : 'image/jpeg',
      media: video
        ? {
            kind: 'video',
            width: 1920,
            height: 1080,
            codedWidth: 1920,
            codedHeight: 1080,
            rotation: 0,
            pixelAspectRatio: { numerator: 1, denominator: 1 },
            streamId: 'cat-planet-v1.2',
            streamIndex: 0,
            timebase: { numerator: 1, denominator: 1000 },
            startTick: 0,
            durationTicks: 259600,
            containerStartSeconds: 0,
          }
        : { kind: 'image', width: 2880, height: 1800 },
    };
    const state = createReviewState(fixture),
      requests = [];
    let slow = true;
    let unavailable = false;
    let releaseMedia;
    const mediaGate = new Promise((resolve) => {
      releaseMedia = resolve;
    });
    const markupKey = `workspace-content-review:${reviewView(state).review.reviewId}:${fixture.revision}:markup`;
    await page.addInitScript((key) => localStorage.setItem(key, '{invalid-saved-draft'), markupKey);
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
      if (url.pathname === '/api/workspace/file/raw' || url.pathname.endsWith('/media')) {
        if (url.pathname.endsWith('/media')) await mediaGate;
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
        const start = range ? Number(range[1]) : 0,
          end = range
            ? Math.min(bytes.length - 1, range[2] ? Number(range[2]) : start + 1024 * 1024 - 1)
            : bytes.length - 1;
        return route.fulfill({
          status: range ? 206 : 200,
          contentType: fixture.mime,
          headers: {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
          },
          body: bytes.subarray(start, end + 1),
        });
      }
      if (url.pathname.startsWith('/api/')) {
        const row = { path: url.pathname, method: request.method(), start: Date.now() };
        requests.push(row);
        if (
          slow &&
          [
            '/api/workspace/file',
            '/api/workspace/resolve-file-source',
            '/api/workspace/content-reviews/prepare',
          ].includes(url.pathname)
        )
          await new Promise((resolve) => setTimeout(resolve, 1200));
        let value = fixtureForApi(url, 'filename', state);
        if (url.pathname === '/api/workspace/resolve-file-source')
          value = { kind: 'file', worktreeId: canonicalWorktreeId(WORKTREE_ID), path: name };
        if (url.pathname.startsWith('/api/workspace/content-reviews')) {
          value = reviewView(state);
          if (unavailable) value = { ...value, sourceState: 'unavailable', canWrite: false };
        }
        if (url.pathname === '/api/content-modifications/context') value = { requests: [] };
        if (url.pathname === '/api/workspace/chat-references') value = { groups: [] };
        row.end = Date.now();
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      }
      const asset = path.resolve(web, 'public', url.pathname.slice(1));
      if (asset.startsWith(path.join(web, 'public/'))) {
        const data = await readFile(asset).catch(() => null);
        if (data)
          return route.fulfill({
            body: data,
            contentType: url.pathname.endsWith('.woff2') ? 'font/woff2' : 'image/png',
          });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`https://f309-open.test/?video=${video ? '1' : '0'}`);
    await page.getByRole('textbox', { name: 'original composer' }).waitFor();
    await page.evaluate(() => {
      window.__originalComposer = document.querySelector('textarea');
    });
    if (!video)
      await page
        .locator('main img')
        .first()
        .evaluate((img) => img.decode());
    // FileBlock has a visible filename/action, whereas gallery thumbnails have
    // an aria-label. Use each original user-facing entry rather than a fake button.
    const opener = video
      ? page.locator('main').getByRole('button').filter({ hasText: name }).first()
      : page.locator('main button[aria-label^="打开作品"]').first();
    const samples = [];
    const record = { name, samples, requests };
    results.push(record);
    for (let run = 0; run < 3; run++) {
      await page.evaluate(installFirstFrameProbe);
      await opener.click();
      await page.waitForFunction(() => window.__firstFrame !== null, null, { timeout: 10000 });
      const milliseconds = await page.evaluate(() => window.__firstFrame);
      assert.ok(milliseconds < 1000, `${name}: first pixels took ${milliseconds}ms`);
      const waitingOwner = requests.some((row) => !row.end);
      assert.ok(waitingOwner, 'first pixels must precede an outstanding real fetch');
      samples.push({ run: run + 1, firstFrameMs: milliseconds, ownerStillPending: waitingOwner });
      if (run < 2) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(40);
      } else if (video) {
        await page.locator('[data-testid="artwork-chat-preview"] video').evaluate(
          (node) =>
            new Promise((resolve) => {
              node.currentTime = 42;
              node.requestVideoFrameCallback(() => resolve());
            }),
        );
      }
    }
    await page.screenshot({ path: path.join(evidence, `${video ? 'video' : 'j6'}-preview.png`) });
    slow = false;
    await page.waitForSelector('[role="dialog"] [data-testid="workspace-content-review-media"]', { timeout: 15000 });
    await page
      .locator('[data-testid="workspace-review-artwork"] [role="alert"]')
      .filter({ hasText: '原标记草稿暂时无法读取' })
      .waitFor({ state: 'attached' });
    assert.equal(
      await page.locator('[data-testid="artwork-chat-preview"]').count(),
      1,
      'a real markup draft warning must not expose undecoded owner media',
    );
    record.ancillaryAlertKeptPreview = true;
    releaseMedia();
    await page.waitForSelector('[data-testid="artwork-chat-preview"]', { state: 'detached', timeout: 15000 });
    if (video)
      assert.ok(
        Math.abs(
          (await page.locator('[data-testid="workspace-content-review-media"]').evaluate((node) => node.currentTime)) -
            42,
        ) < 0.1,
        'the verified player must retain the preview playhead at forty-two seconds',
      );
    assert.equal(
      await page.evaluate(() => document.querySelector('[role="dialog"] textarea') === window.__originalComposer),
      true,
    );
    assert.equal(await page.getByRole('textbox', { name: 'original composer' }).inputValue(), '尚未发送的原草稿');
    await page.screenshot({ path: path.join(evidence, `${video ? 'video' : 'j6'}-owner.png`) });
    const composerGeometry = await page.evaluate(() => {
      const node = window.__originalComposer;
      const rect = node.getBoundingClientRect();
      const ancestors = [];
      for (let parent = node.parentElement; parent && ancestors.length < 6; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        ancestors.push({
          tag: parent.tagName,
          className: parent.className,
          rect: parent.getBoundingClientRect().toJSON(),
          display: style.display,
          overflow: style.overflow,
          flex: style.flex,
          height: style.height,
        });
      }
      return {
        rect: rect.toJSON(),
        viewportHeight: innerHeight,
        hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node,
        ancestors,
      };
    });
    record.composerGeometry = composerGeometry;
    assert.ok(
      composerGeometry.rect.height > 0 &&
        composerGeometry.rect.y >= 0 &&
        composerGeometry.rect.bottom <= composerGeometry.viewportHeight &&
        composerGeometry.hit,
      `the original composer must remain visibly usable: ${JSON.stringify(composerGeometry)}`,
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('textarea') === window.__originalComposer), true);
    await page.setViewportSize({ width: 390, height: 844 });
    slow = true;
    await opener.click();
    await page.locator('[data-testid="artwork-chat-preview"]').waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector(
        '[data-testid="artwork-chat-preview"] img, [data-testid="artwork-chat-preview"] video',
      );
      return node instanceof HTMLImageElement
        ? node.complete && node.naturalWidth > 0
        : node instanceof HTMLVideoElement && node.readyState >= 2 && node.videoWidth > 0;
    });
    await page.screenshot({ path: path.join(evidence, `${video ? 'video' : 'j6'}-preview-390.png`) });
    await page.waitForSelector('[data-testid="artwork-chat-preview"]', { state: 'detached', timeout: 15000 });
    if (video)
      assert.ok(
        Math.abs(
          (await page.locator('[data-testid="workspace-content-review-media"]').evaluate((node) => node.currentTime)) -
            42,
        ) < 0.1,
        'reopening with an untouched preview must retain the original owner position',
      );
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('textarea') === window.__originalComposer), true);
    unavailable = true;
    slow = false;
    await opener.click();
    await page.getByText('原内容当前不可读取；协作历史保留，但不展示旧内容缓存。').waitFor({ state: 'attached' });
    await page.waitForSelector('[data-testid="artwork-chat-preview"]', { state: 'detached', timeout: 15000 });
    assert.equal(await page.locator('[data-testid="workspace-content-review-media"]').count(), 0);
    record.unavailableExposed = true;
    await page.screenshot({ path: path.join(evidence, `${video ? 'video' : 'j6'}-unavailable.png`) });
    await page.keyboard.press('Escape');
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ driverSha256, results, errors }, null, 2));
}
console.log(
  JSON.stringify({ status: 'pass', results: results.map(({ name, samples }) => ({ name, samples })), errors }),
);
