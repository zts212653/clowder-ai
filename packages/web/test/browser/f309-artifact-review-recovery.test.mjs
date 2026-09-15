import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture, offsetRotatedVfrFixture } from './fixtures/f309-artifact-review-media.mjs';
import { selectReviewMode } from './fixtures/f309-artwork-controls.mjs';
import { installMediaDiagnostics, readMediaDiagnostics } from './fixtures/f309-media-diagnostics.mjs';

async function openReview(page, host) {
  await page.goto(host.origin);
  await page.getByTestId('open-artifact-review').click();
  await page.getByTestId('review-media-stage').waitFor();
}
async function circle(page, media) {
  const stage = page.getByTestId('review-media-stage');
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  assert.ok(box);
  const scale = Math.min(box.width / media.width, box.height / media.height);
  const width = media.width * scale,
    height = media.height * scale;
  const x = box.x + (box.width - width) / 2,
    y = box.y + (box.height - height) / 2;
  await page.mouse.move(x + width * 0.25, y + height * 0.3);
  await page.mouse.down();
  await page.mouse.move(x + width * 0.65, y + height * 0.6);
  await page.mouse.up();
}
function decodedFrameIndex(rgb, samples) {
  const size = 16 * 16 * 3;
  let best = { index: -1, error: Infinity };
  for (let index = 0; index < samples.length / size; index++) {
    let error = 0;
    for (let pixel = 0; pixel < size; pixel++) error += Math.abs(rgb[pixel] - samples[index * size + pixel]);
    error /= size;
    if (error < best.error) best = { index, error };
  }
  assert.ok(
    best.error < 12,
    `browser displayed frame differs from the rotated FFmpeg reference: ${JSON.stringify(best)}`,
  );
  return best;
}
for (const kind of ['png', 'mp4'])
  test(`F309 ${kind}: real frame/coordinates, exact return and source revocation`, { timeout: 150000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), `f309-recovery-${kind}-`));
    const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
    await mkdir(evidence, { recursive: true });
    const clock = kind === 'mp4' ? await offsetRotatedVfrFixture(root) : null;
    if (kind === 'png') await mediaFixture(root, kind);
    let host, browser, page;
    const errors = [];
    t.after(async () => {
      if (page && !page.isClosed()) {
        await writeFile(
          path.join(evidence, `${kind}-media-events.json`),
          JSON.stringify(await readMediaDiagnostics(page), null, 2),
        );
        await writeFile(
          path.join(evidence, `${kind}-recovery-state.json`),
          JSON.stringify(
            {
              errors,
              text: await page
                .locator('body')
                .innerText()
                .catch(() => ''),
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: path.join(evidence, `${kind}-recovery.png`), fullPage: true }).catch(() => {});
      }
      await browser?.close();
      await host?.close();
      if (root !== evidence) await rm(root, { recursive: true, force: true });
    });
    host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    await installMediaDiagnostics(page);
    page.on('pageerror', (error) => errors.push(error.message));
    await openReview(page, host);
    const reviewId = host.store.listReviewIds('operator')[0];
    let view = await host.reviews.read(reviewId, host.human);
    let displayed, matched;
    if (clock) {
      const media = view.review.rounds[0].asset.media;
      assert.equal(media.rotation, 90);
      assert.equal(media.containerStartSeconds, 2);
      assert.ok(media.startTick > 0);
      const pts = clock.frames.map((frame) => frame.pts);
      assert.ok(
        new Set(pts.slice(1).map((tick, i) => tick - pts[i])).size > 1,
        'fixture must actually have variable frame durations',
      );
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      displayed = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const video = document.querySelector('video');
            video.muted = true;
            video.requestVideoFrameCallback((_now, metadata) => {
              video.pause();
              const canvas = document.createElement('canvas');
              canvas.width = 16;
              canvas.height = 16;
              const context = canvas.getContext('2d');
              context.drawImage(video, 0, 0, 16, 16);
              const rgba = context.getImageData(0, 0, 16, 16).data;
              resolve({
                mediaTime: metadata.mediaTime,
                currentTime: video.currentTime,
                duration: video.duration,
                width: video.videoWidth,
                height: video.videoHeight,
                rgb: [...rgba].filter((_value, index) => index % 4 !== 3),
              });
            });
            video.currentTime = 2.12;
            void video.play();
          }),
      );
      assert.equal(displayed.width, media.width);
      assert.equal(displayed.height, media.height);
      matched = decodedFrameIndex(displayed.rgb, clock.samples);
      await selectReviewMode(page, 'view');
      await page.getByRole('button', { name: '圈出这帧画面', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '圈选区域', exact: true }).click();
    }
    await circle(page, view.review.rounds[0].asset.media);
    await page.getByRole('textbox', { name: '新增标注意见' }).fill('帧坐标及撤权恢复的陌生意见');
    await page.getByRole('button', { name: '保存标注', exact: true }).click();
    await page.getByTestId('review-comment').waitFor();
    view = await host.reviews.read(reviewId, host.human);
    const anchor = view.review.rounds[0].annotations[0].anchor;
    const region = kind === 'png' ? anchor : anchor.frameRegion;
    assert.ok(region);
    const media = view.review.rounds[0].asset.media;
    assert.ok(Math.abs(region.x / media.width - 0.25) < 0.01);
    assert.ok(Math.abs(region.height / media.height - 0.3) < 0.01);
    if (clock) {
      await writeFile(
        path.join(evidence, 'mp4-clock.json'),
        JSON.stringify(
          {
            media,
            displayed,
            matched,
            expectedTick: clock.frames[matched.index].pts,
            anchor,
          },
          null,
          2,
        ),
      );
      assert.equal(
        anchor.frameRegion.tick,
        clock.frames[matched.index].pts,
        'saved frame tick must identify the independently decoded, actually displayed frame',
      );
    }
    const draft = page.getByRole('textbox', { name: '新增标注意见' });
    await selectReviewMode(page, 'comment');
    await draft.fill('返回原入口后还在的草稿');
    await page.getByRole('button', { name: '← 回到原处', exact: true }).click();
    const selected = page
      .getByTestId('product-schedule-item')
      .filter({ has: page.locator('[data-testid="entrusted-work-brief"]') });
    await selected.waitFor();
    assert.equal(await selected.getAttribute('data-selected'), 'true');
    assert.equal(await selected.getAttribute('data-subject-ref'), `task:work:${host.taskId}`);
    await page.getByTestId('open-artifact-review').click();
    await draft.waitFor();
    assert.equal(await draft.inputValue(), '返回原入口后还在的草稿');
    await page.reload();
    await draft.waitFor();
    assert.equal(await draft.inputValue(), '返回原入口后还在的草稿');
    if (clock) {
      await page.getByRole('button', { name: '标注 1', exact: true }).click();
      await page.waitForFunction((time) => {
        const video = document.querySelector('video');
        return video && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.01;
      }, displayed.mediaTime);
      const restoredRgb = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const context = canvas.getContext('2d');
        context.drawImage(document.querySelector('video'), 0, 0, 16, 16);
        return [...context.getImageData(0, 0, 16, 16).data].filter((_value, index) => index % 4 !== 3);
      });
      assert.equal(
        decodedFrameIndex(restoredRgb, clock.samples).index,
        matched.index,
        'opening the retained annotation must seek back to the same independently decoded frame',
      );
      await selectReviewMode(page, 'view');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent.trim() === '圈出这帧画面' && !button.disabled,
        ),
      );
      await selectReviewMode(page, 'view');
      await page.getByRole('button', { name: '圈出这帧画面', exact: true }).click();
      await circle(page, media);
      const continued = await page.evaluate(
        (id) => JSON.parse(localStorage.getItem(`cat-cafe:review:operator:${id}:round:1:annotation`)),
        reviewId,
      );
      assert.equal(
        continued.anchor.frameRegion.tick,
        clock.frames[matched.index].pts,
        'continuing to circle the restored paused frame must keep its actual presentation tick',
      );
      // Scrubbing within this VFR frame and selecting it again must stay usable, without guessing frame rate.
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 2.13;
      });
      await page.waitForFunction(() => !document.querySelector('video').seeking);
      await selectReviewMode(page, 'view');
      await page.getByRole('button', { name: '圈出这帧画面', exact: true }).click();
      await circle(page, media);
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 2.84;
      });
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return !video.seeking && Math.abs(video.currentTime - 2.84) < 0.01;
      });
      const refreshed = page.waitForResponse(
        (response) => response.url() === `${host.apiOrigin}/api/artifact-reviews/${reviewId}`,
      );
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await refreshed;
      assert.ok(
        Math.abs((await page.locator('video').evaluate((video) => video.currentTime)) - 2.84) < 0.01,
        'owner refresh must not interrupt the user playback position',
      );
      await page.getByRole('button', { name: '标注 1', exact: true }).click();
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return !video.seeking && Math.abs(video.currentTime - 2.12) < 0.01;
      });
      await selectReviewMode(page, 'view');
      await page.getByRole('button', { name: '圈出这帧画面', exact: true }).click();
      await circle(page, media);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByTestId('f307-sidecar-expand').click();
    const brief = await page.getByTestId('entrusted-work-brief').boundingBox();
    assert.ok(brief && brief.width > 220, `the original Task must remain legible in 390px layout: ${brief?.width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(evidence, `${kind}-recovery-mobile.png`), fullPage: true });
    await host.messages.softDelete(host.publication.id, 'operator');
    await page.getByRole('button', { name: '刷新', exact: true }).first().click();
    await page.getByText('这份内容现在不可访问，旧预览已关闭。', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('review-media-stage').count(), 0);
    assert.equal(await page.getByText('帧坐标及撤权恢复的陌生意见', { exact: true }).count(), 0);
    assert.equal(
      await page.evaluate(
        (id) => Object.keys(localStorage).some((key) => key.startsWith(`cat-cafe:review:operator:${id}:`)),
        reviewId,
      ),
      false,
    );
    const hidden = await host.app.inject({ method: 'GET', url: `/api/artifact-reviews/${reviewId}/media/1` });
    assert.equal(hidden.statusCode, 403);
    await page.reload();
    await page.getByText('这份内容现在不可访问，旧预览已关闭。', { exact: true }).waitFor();
    assert.equal(await page.locator('video, [data-testid="review-media-stage"] img').count(), 0);
    assert.deepEqual(errors, []);
  });
