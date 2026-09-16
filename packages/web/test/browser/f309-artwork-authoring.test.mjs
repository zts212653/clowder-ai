import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import { selectMarkupTool, selectReviewMode } from './fixtures/f309-artwork-controls.mjs';

const sharp = createRequire(new URL('../../../api/package.json', import.meta.url))('sharp');
async function presentFrame(page, seconds) {
  await page.locator('video').evaluate((video, time) => {
    window.__f309AuthoringFrames = [];
    const capture = (_now, frame) => {
      window.__f309AuthoringFrames.push(frame.mediaTime);
      video.requestVideoFrameCallback(capture);
    };
    video.requestVideoFrameCallback(capture);
    video.pause();
    video.currentTime = time;
  }, seconds);
  await page.waitForFunction(
    (time) =>
      window.__f309AuthoringFrames.some((shown) => Math.abs(shown - time) < 0.005) &&
      !document.querySelector('video').seeking,
    seconds,
  );
}
async function open(page, host) {
  await page.goto(host.origin);
  await page.getByTestId('open-artifact-review').click();
  await page.locator('[data-testid="review-media-stage"] img, [data-testid="review-media-stage"] video').waitFor();
}
async function at(page, x, y) {
  // Target an actual media point. The stage can contain letterboxing after zoom/resize.
  return page
    .getByTestId('review-media-stage')
    .locator('svg[aria-label="标注区域"]')
    .evaluate(
      (svg, point) => {
        const matrix = svg.getScreenCTM();
        if (!matrix) throw new Error('The media coordinate space is not rendered.');
        const position = new DOMPoint(
          point.x * svg.viewBox.baseVal.width,
          point.y * svg.viewBox.baseVal.height,
        ).matrixTransform(matrix);
        return { x: position.x, y: position.y };
      },
      { x, y },
    );
}
async function drag(page, from, to) {
  const a = await at(page, ...from),
    b = await at(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}
async function fixture(t, kind = 'png') {
  const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-authoring-'));
  await mediaFixture(root, kind);
  const host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => {
    await page.screenshot({ path: path.join(root, 'final.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ errors }, null, 2));
    await browser.close();
    await host.close();
    if (t.passed) await rm(root, { recursive: true, force: true });
    else console.log(`artwork evidence: ${root}`);
  });
  await open(page, host);
  const reviewId = host.store.listReviewIds('operator')[0];
  return { root, host, browser, page, errors, reviewId, read: () => host.reviews.read(reviewId, host.human) };
}

test(
  'F309 artwork authoring: video drawings and point comments retain their presented frame after refresh',
  { timeout: 90000 },
  async (t) => {
    const { page, errors, read } = await fixture(t, 'mp4');
    await presentFrame(page, 0.4);
    await selectReviewMode(page, 'markup');
    await selectMarkupTool(page, '画笔');
    await drag(page, [0.25, 0.3], [0.45, 0.55]);
    await page.getByRole('button', { name: '保存标记', exact: true }).click();
    await page.getByTestId('review-saved-mark').waitFor();
    let view = await read();
    const drawing = view.review.rounds[0].visualMarks[0].drawing;
    const media = view.review.rounds[0].asset.media;
    assert.equal(drawing.frame.tick, Math.round((0.4 * media.timebase.denominator) / media.timebase.numerator));
    await selectReviewMode(page, 'comment');
    const point = await at(page, 0.65, 0.5);
    await page.mouse.click(point.x, point.y);
    await page.getByLabel('片段终点').fill('1.8');
    await page.getByLabel('新增标注意见').fill('这一帧的动作 sentinel-video-point');
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    await page.getByTestId('review-comment').filter({ hasText: 'sentinel-video-point' }).waitFor();
    view = await read();
    assert.equal(view.review.rounds[0].annotations[0].anchor.framePoint.tick, drawing.frame.tick);
    assert.equal(
      view.review.rounds[0].annotations[0].anchor.endTick,
      Math.round((1.8 * media.timebase.denominator) / media.timebase.numerator),
    );
    await page.reload();
    await page.locator('video').waitFor();
    await presentFrame(page, 1.6);
    await page.getByTestId('review-saved-mark').waitFor({ state: 'hidden' });
    await presentFrame(page, 0.4);
    await page.getByTestId('review-saved-mark').waitFor();
    assert.equal(await page.getByLabel('调整比例', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  },
);

test(
  'F309 artwork authoring: saved marks and point comments survive another browser; region request returns through the same Task',
  { timeout: 90000 },
  async (t) => {
    const { root, host, browser, page, errors, reviewId, read } = await fixture(t);
    await selectReviewMode(page, 'markup');
    await selectMarkupTool(page, '画笔');
    await drag(page, [0.3, 0.35], [0.5, 0.55]);
    await page.getByRole('button', { name: '保存标记', exact: true }).click();
    await page.getByTestId('review-saved-mark').waitFor();
    let view = await read();
    assert.equal(view.review.rounds[0].visualMarks.length, 1);
    assert.equal(view.review.rounds[0].annotations.length, 0);
    assert.equal(host.starts.length, 0);
    const other = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await open(other, host);
    await other.getByTestId('review-saved-mark').waitFor();
    await other.close();
    // Zoom changes the rendered viewport, never the persisted media coordinate space.
    await page.evaluate(() => {
      document.body.style.zoom = '1.25';
    });
    await selectReviewMode(page, 'comment');
    const point = await at(page, 0.6, 0.4);
    await page.mouse.click(point.x, point.y);
    await page.getByLabel('新增标注意见').fill('灯光只调整这一处 sentinel-point');
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    await page.getByTestId('review-comment').filter({ hasText: 'sentinel-point' }).waitFor();
    view = await read();
    assert.equal(view.review.rounds[0].annotations[0].anchor.kind, 'image-point');
    const pointAnchor = view.review.rounds[0].annotations[0].anchor;
    const imageMedia = view.review.rounds[0].asset.media;
    assert.ok(Math.abs(pointAnchor.x - imageMedia.width * 0.6) < 2);
    assert.ok(Math.abs(pointAnchor.y - imageMedia.height * 0.4) < 2);
    await page.getByRole('button', { name: '关闭审阅面板', exact: true }).click();
    await page.evaluate(() => {
      document.body.style.zoom = '1';
    });
    await selectReviewMode(page, 'view');
    await page.getByRole('button', { name: '圈选区域', exact: true }).click();
    await drag(page, [0.7, 0.25], [0.85, 0.45]);
    await page.getByLabel('新增标注意见').fill('保留边缘的叶子 sentinel-erase');
    await page.getByRole('button', { name: '让猫移除这里', exact: true }).click();
    await page.getByTestId('review-return-state').filter({ hasText: '修改请求已交还' }).waitFor();
    view = await read();
    assert.equal(view.review.rounds[0].annotations[1].imageEdit.kind, 'erase-region');
    assert.equal(view.review.rounds[0].annotations[1].author.actorId, 'operator');
    assert.equal(host.starts.length, 1);
    const inspected = await host.catCallback('read', { reviewId, view: 'annotations' });
    assert.ok(inspected.records.some((row) => row.path === '/1/imageEdit/kind' && row.value === 'erase-region'));
    await mediaFixture(root, 'png', 2);
    const publication = host.publish('review-response.png');
    const updated = await host.catCallback('respond', {
      reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: view.authority.taskRevision,
      expectedOwnerRevision: 1,
      operationId: 'authoring-image-response',
      artifactRef: '/uploads/review-response.png',
      expectedArtifactRevision: String(publication.timestamp),
      responses: view.review.rounds[0].annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '按这条意见完成新版本',
      })),
    });
    assert.equal(updated.continuation.taskId, view.review.task.taskId);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '查看最新第 2 版', exact: true }).click();
    await page.getByTestId('review-saved-mark').waitFor({ state: 'hidden' });
    await page.getByLabel('审阅版本').selectOption('1');
    await page.getByTestId('review-saved-mark').waitFor();
    assert.equal(await page.getByRole('button', { name: '标注', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  },
);

test(
  'F309 artwork authoring: narrow-screen ratio menu sends the typed target and receives a correctly sized new version',
  { timeout: 90000 },
  async (t) => {
    const { root, host, page, errors, reviewId, read } = await fixture(t);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('调整比例', { exact: true }).click();
    const choice = page.getByRole('button', { name: '让猫调整为 9:16', exact: true });
    const box = await choice.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    const previous = (await read()).review.rounds[0].asset;
    await choice.click();
    await page.getByTestId('review-return-state').filter({ hasText: '修改请求已交还' }).waitFor();
    let view = await read();
    assert.deepEqual(view.review.rounds[0].asset, previous);
    assert.deepEqual(view.review.rounds[0].annotations[0].imageEdit, { kind: 'aspect-ratio', ratio: '9:16' });
    assert.equal(host.starts.length, 1);
    await sharp({ create: { width: 360, height: 640, channels: 3, background: '#d3b698' } })
      .png()
      .toFile(path.join(root, 'review-response.png'));
    const publication = host.publish('review-response.png');
    await host.catCallback('respond', {
      reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: view.authority.taskRevision,
      expectedOwnerRevision: 1,
      operationId: 'authoring-ratio-response',
      artifactRef: '/uploads/review-response.png',
      expectedArtifactRevision: String(publication.timestamp),
      responses: [
        {
          annotationId: view.review.rounds[0].annotations[0].id,
          disposition: 'addressed',
          explanation: '新版本为 360 × 640，9:16。',
        },
      ],
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '查看最新第 2 版', exact: true }).click();
    view = await read();
    assert.equal(view.review.rounds[1].asset.media.width / view.review.rounds[1].asset.media.height, 9 / 16);
    assert.deepEqual(errors, []);
  },
);
