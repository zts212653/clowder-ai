import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import { openReviewPanel, selectReviewMode } from './fixtures/f309-artwork-controls.mjs';

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

test('F309 artwork: a video comment gesture cannot cross presented frames', { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-frame-safety-'));
  const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
  await mkdir(evidence, { recursive: true });
  await mediaFixture(root, 'mp4');
  const host = await startReviewHost(root, 'video/mp4');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => {
    if (!page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, `${t.name}.png`), fullPage: true }).catch(() => {});
      await writeFile(path.join(evidence, `${t.name}.json`), JSON.stringify({ errors }, null, 2));
    }
    await browser.close();
    await host.close();
    if (root !== evidence) await rm(root, { recursive: true, force: true });
  });

  await page.goto(host.origin);
  await page.getByTestId('open-artifact-review').click();
  await page.locator('video').waitFor();
  const reviewId = host.store.listReviewIds('operator')[0];
  const view = await host.reviews.read(reviewId, host.human);
  const media = view.review.rounds[0].asset.media;
  const laterTick = Math.round((1.6 * media.timebase.denominator) / media.timebase.numerator);
  await host.reviews.act(
    {
      reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: 1,
      round: 1,
      operationId: 'frame-safety-later-annotation',
      action: {
        kind: 'annotate',
        annotationId: 'frame-safety-later-annotation',
        anchor: {
          kind: 'video-range',
          streamId: media.streamId,
          startTick: media.startTick,
          endTick: media.startTick + media.durationTicks,
          frameRegion: { tick: laterTick, x: 50, y: 50, width: 120, height: 100 },
        },
        body: 'Focuses the actual UI onto a later presented frame.',
      },
    },
    host.human,
  );
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  await openReviewPanel(page, 'comments');
  await page.getByTestId('review-comment').waitFor();
  await page.getByRole('button', { name: '关闭审阅面板', exact: true }).click();
  const video = page.locator('video');
  await video.evaluate((element) => {
    window.__f309FrameSafetyFrames = [];
    const capture = (_now, metadata) => {
      window.__f309FrameSafetyFrames.push(metadata.mediaTime);
      element.requestVideoFrameCallback(capture);
    };
    element.requestVideoFrameCallback(capture);
    element.pause();
    element.currentTime = 0.4;
  });
  await page.waitForFunction(
    () =>
      window.__f309FrameSafetyFrames.some((time) => Math.abs(time - 0.4) < 0.01) &&
      !document.querySelector('video')?.seeking,
  );
  await selectReviewMode(page, 'comment');
  const annotationKey = `cat-cafe:review:operator:${reviewId}:round:1:annotation`;
  const before = await page.evaluate((key) => localStorage.getItem(key), annotationKey);
  await page.getByRole('button', { name: '标注 1', exact: true }).focus();
  const start = await canvasPoint(page, 320, 80, media);
  const end = await canvasPoint(page, 480, 180, media);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 3 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      window.__f309FrameSafetyFrames.some((time) => Math.abs(time - 1.6) < 0.01) &&
      !document.querySelector('video')?.seeking,
  );
  await page.mouse.up();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), annotationKey), before);
  assert.deepEqual(errors, []);
});
