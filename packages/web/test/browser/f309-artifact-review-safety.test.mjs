import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import { selectMarkupTool, selectReviewMode } from './fixtures/f309-artwork-controls.mjs';

async function openReview(page, host) {
  await page.goto(host.origin);
  await page.getByTestId('product-schedule-panel').waitFor();
  await page.getByTestId('open-artifact-review').click();
  await page.getByTestId('artifact-review-surface').waitFor();
  await page.locator('[data-testid="review-media-stage"] img, [data-testid="review-media-stage"] video').waitFor();
}

async function canvasPoint(page, x, y, media) {
  const stage = page.getByTestId('review-media-stage');
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  assert.ok(box);
  const scale = Math.min(box.width / media.width, box.height / media.height);
  return {
    x: box.x + (box.width - media.width * scale) / 2 + x * scale,
    y: box.y + (box.height - media.height * scale) / 2 + y * scale,
  };
}

async function draw(page, tool, from, to, media, steps = 4) {
  await selectMarkupTool(page, tool);
  const start = await canvasPoint(page, ...from, media);
  const end = await canvasPoint(page, ...to, media);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps });
  await page.mouse.up();
}

async function withReview(t, kind, run) {
  const root = await mkdtemp(path.join(tmpdir(), `f309-artwork-safety-${kind}-`));
  const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
  await mkdir(evidence, { recursive: true });
  await mediaFixture(root, kind);
  const host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => {
    if (!page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, `${kind}-${t.name}.png`), fullPage: true }).catch(() => {});
      await writeFile(path.join(evidence, `${kind}-${t.name}.json`), JSON.stringify({ errors }, null, 2));
    }
    await browser.close();
    await host.close();
    if (root !== evidence) await rm(root, { recursive: true, force: true });
  });
  await run({ host, page });
  assert.deepEqual(errors, []);
}

test('F309 artwork: comment mode keeps real discussion markers reachable', { timeout: 90000 }, async (t) => {
  await withReview(t, 'png', async ({ host, page }) => {
    await openReview(page, host);
    const reviewId = host.store.listReviewIds('operator')[0];
    const view = await host.reviews.read(reviewId, host.human);
    await host.reviews.act(
      {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 1,
        round: 1,
        operationId: 'safety-existing-comment',
        action: {
          kind: 'annotate',
          annotationId: 'safety-existing-comment',
          anchor: { kind: 'image-region', x: 100, y: 100, width: 200, height: 150 },
          body: 'An existing discussion remains reachable in comment mode.',
        },
      },
      host.human,
    );
    await page.getByRole('button', { name: '刷新', exact: true }).first().click();
    await selectReviewMode(page, 'comment');
    const mark = page.getByTestId('review-canvas-annotation-mark');
    const annotationKey = `cat-cafe:review:operator:${reviewId}:round:1:annotation`;
    const draftBeforeOpen = await page.evaluate((key) => localStorage.getItem(key), annotationKey);
    await mark.click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'review-comment');
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark',
    );
    await page.keyboard.press(' ');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'review-comment');
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark',
    );
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), annotationKey), draftBeforeOpen);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'review-comment');
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark',
    );
    await selectReviewMode(page, 'view');
    await page.getByRole('button', { name: '圈选区域', exact: true }).click();
    await selectReviewMode(page, 'comment');
    await mark.click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'review-comment');
  });
});

test(
  'F309 artwork: unavailable markup mode cannot turn an unfinished selection into a comment draft',
  { timeout: 90000 },
  async (t) => {
    await withReview(t, 'png', async ({ host, page }) => {
      await openReview(page, host);
      const reviewId = host.store.listReviewIds('operator')[0];
      const media = (await host.reviews.read(reviewId, host.human)).review.rounds[0].asset.media;
      const markupKey = `cat-cafe:review:operator:${reviewId}:round:1:markup`;
      const annotationKey = `cat-cafe:review:operator:${reviewId}:round:1:annotation`;
      await page.evaluate((key) => localStorage.setItem(key, '{unreadable-markup-sentinel'), markupKey);
      await page.evaluate(
        (key) =>
          localStorage.setItem(
            key,
            JSON.stringify({
              body: '已有的评论草稿不可被标注模式改写。',
              anchor: { kind: 'image-region', x: 40, y: 50, width: 80, height: 60 },
            }),
          ),
        annotationKey,
      );
      await page.reload();
      await selectReviewMode(page, 'view');
      await page.getByRole('button', { name: '圈选区域', exact: true }).click();
      await selectReviewMode(page, 'markup');
      await page.getByRole('alert').filter({ hasText: '未覆盖原记录' }).waitFor();
      const before = await page.evaluate((key) => localStorage.getItem(key), annotationKey);
      const start = await canvasPoint(page, 400, 100, media);
      const end = await canvasPoint(page, 600, 230, media);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      await page.mouse.up();
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), annotationKey), before);
      assert.equal(await page.getByTestId('review-markup-layer').count(), 0);
      assert.equal(await page.getByRole('region', { name: '作品画布工具' }).getAttribute('data-review-mode'), 'markup');
    });
  },
);

test(
  'F309 artwork: a second or late pointer cannot cross a comment-selection boundary',
  { timeout: 90000 },
  async (t) => {
    await withReview(t, 'png', async ({ host, page }) => {
      await openReview(page, host);
      const reviewId = host.store.listReviewIds('operator')[0];
      const media = (await host.reviews.read(reviewId, host.human)).review.rounds[0].asset.media;
      const annotationKey = `cat-cafe:review:operator:${reviewId}:round:1:annotation`;
      await page.getByRole('button', { name: '圈选区域', exact: true }).click();
      const start = await canvasPoint(page, 100, 100, media);
      const end = await canvasPoint(page, 300, 250, media);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 3 });
      await page.evaluate(({ x, y }) => {
        document
          .querySelector('[aria-label="标注区域"]')
          ?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 999 }));
      }, end);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), annotationKey), null);
      await page.mouse.up();
      await page.waitForFunction((key) => localStorage.getItem(key) !== null, annotationKey);
      const saved = await page.evaluate((key) => localStorage.getItem(key), annotationKey);
      await page.evaluate(({ x, y }) => {
        document
          .querySelector('[aria-label="标注区域"]')
          ?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 999 }));
      }, end);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), annotationKey), saved);
    });
  },
);

test(
  'F309 artwork: failed or unknown local markup reads never overwrite stored work',
  { timeout: 90000 },
  async (t) => {
    await withReview(t, 'png', async ({ host, page }) => {
      await openReview(page, host);
      const reviewId = host.store.listReviewIds('operator')[0];
      const media = (await host.reviews.read(reviewId, host.human)).review.rounds[0].asset.media;
      const key = `cat-cafe:review:operator:${reviewId}:round:1:markup`;
      const annotationKey = `cat-cafe:review:operator:${reviewId}:round:1:annotation`;
      await selectReviewMode(page, 'markup');
      await draw(page, '矩形', [400, 100], [600, 230], media);
      await page.getByTestId('review-local-mark').waitFor();
      const original = await page.evaluate((storedKey) => localStorage.getItem(storedKey), key);
      assert.ok(original);
      const commentDraft = JSON.stringify({ body: '重读标注不能改写这条评论草稿。', anchor: null });
      await page.evaluate(({ storedKey, value }) => localStorage.setItem(storedKey, value), {
        storedKey: annotationKey,
        value: commentDraft,
      });
      await page.addInitScript((storedKey) => {
        const originalGetItem = Storage.prototype.getItem;
        let failed = false;
        Storage.prototype.getItem = function (name) {
          if (name === storedKey && !failed) {
            failed = true;
            throw new DOMException('simulated transient draft read failure', 'SecurityError');
          }
          return originalGetItem.call(this, name);
        };
      }, key);
      await page.reload();
      await selectReviewMode(page, 'markup');
      await page.getByRole('alert').filter({ hasText: '未覆盖原记录' }).waitFor();
      assert.equal(await page.evaluate((storedKey) => localStorage.getItem(storedKey), key), original);
      assert.equal(await page.evaluate((storedKey) => localStorage.getItem(storedKey), annotationKey), commentDraft);
      await page.getByRole('button', { name: '重新读取草稿', exact: true }).click();
      await page.getByTestId('review-local-mark').waitFor();
      assert.equal(await page.getByTestId('review-local-mark').count(), 1);
      assert.equal(await page.evaluate((storedKey) => localStorage.getItem(storedKey), annotationKey), commentDraft);
      const unsupported = JSON.stringify({ v: 2, marks: [] });
      await page.evaluate(({ storedKey, value }) => localStorage.setItem(storedKey, value), {
        storedKey: key,
        value: unsupported,
      });
      await page.reload();
      await selectReviewMode(page, 'markup');
      await page.getByRole('alert').filter({ hasText: '未覆盖原记录' }).waitFor();
      assert.equal(await page.evaluate((storedKey) => localStorage.getItem(storedKey), key), unsupported);
      const incompatible = JSON.stringify({
        v: 1,
        marks: [
          { id: 'outside', kind: 'rectangle', x: 999, y: 1, width: 10, height: 10, color: '#d04a3a', strokeWidth: 4 },
        ],
      });
      await page.evaluate(({ storedKey, value }) => localStorage.setItem(storedKey, value), {
        storedKey: key,
        value: incompatible,
      });
      await page.reload();
      await selectReviewMode(page, 'markup');
      await page.getByRole('alert').filter({ hasText: '未覆盖原记录' }).waitFor();
      assert.equal(await page.evaluate((storedKey) => localStorage.getItem(storedKey), key), incompatible);
    });
  },
);

test(
  'F309 artwork: a bounded brush stroke keeps its beginning and announces its limit',
  { timeout: 90000 },
  async (t) => {
    await withReview(t, 'png', async ({ host, page }) => {
      await openReview(page, host);
      const reviewId = host.store.listReviewIds('operator')[0];
      const media = (await host.reviews.read(reviewId, host.human)).review.rounds[0].asset.media;
      const key = `cat-cafe:review:operator:${reviewId}:round:1:markup`;
      await selectReviewMode(page, 'markup');
      await page.getByRole('button', { name: '画笔', exact: true }).click();
      const start = await canvasPoint(page, 50, 250, media);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let index = 1; index <= 360; index++) {
        const next = await canvasPoint(page, 50 + index * 2, 250 + (index % 2) * 20, media);
        await page.mouse.move(next.x, next.y);
      }
      await page.mouse.up();
      await page.getByRole('status').filter({ hasText: '300 个点' }).waitFor();
      const stroke = await page.evaluate((storedKey) => JSON.parse(localStorage.getItem(storedKey)).marks[0], key);
      assert.ok(Math.abs(stroke.points[0].x - 50) < 3);
      assert.equal(stroke.points.length, 300);
    });
  },
);

test(
  'F309 artwork: video comments pause and local markup stays on its presented frame',
  { timeout: 90000 },
  async (t) => {
    await withReview(t, 'mp4', async ({ host, page }) => {
      await openReview(page, host);
      const reviewId = host.store.listReviewIds('operator')[0];
      const media = (await host.reviews.read(reviewId, host.human)).review.rounds[0].asset.media;
      const key = `cat-cafe:review:operator:${reviewId}:round:1:markup`;
      const video = page.locator('video');
      await video.evaluate(async (element) => {
        element.loop = true;
        element.muted = true;
        await element.play();
      });
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2);
      await selectReviewMode(page, 'comment');
      assert.equal(await video.evaluate((element) => element.paused), true);
      await video.evaluate((element) => {
        element.pause();
        element.currentTime = 0.4;
      });
      await page.waitForFunction(() => !document.querySelector('video')?.seeking);
      await selectReviewMode(page, 'markup');
      await page.getByTestId('review-markup-layer').waitFor();
      await draw(page, '矩形', [100, 80], [240, 190], media);
      await page.getByTestId('review-local-mark').waitFor();
      const stored = await page.evaluate((storedKey) => JSON.parse(localStorage.getItem(storedKey)), key);
      assert.equal(stored.marks[0].frame.streamId, media.streamId);
      assert.equal(typeof stored.marks[0].frame.tick, 'number');
      await selectReviewMode(page, 'view');
      await video.evaluate((element) => {
        element.currentTime = 1.6;
      });
      await page.waitForFunction(() => !document.querySelector('video')?.seeking);
      await selectReviewMode(page, 'markup');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="review-local-mark"]').length === 0);
    });
  },
);
