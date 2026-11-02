import assert from 'node:assert/strict';
import path from 'node:path';
import { decodedSeek } from './f326-screening-journey.harness.mjs';

/** The existing native Chat journey owns setup and cleanup; this adds the three-place visual contract. */
export async function checkF326MediaPreviews({ page, surface, toolbar, video, evidence, duration, circle, language }) {
  await decodedSeek(video, Math.min(82, duration * 0.8));
  await circle(0.35, 0.65, '这里的画面再亮一点');
  const group = page.getByTestId('gallery-composer-group');
  const previews = group.getByTestId('media-selection-preview');
  await page.waitForFunction(() => {
    const nodes = [
      ...document.querySelectorAll('[data-testid="gallery-composer-group"] [data-testid="media-selection-preview"]'),
    ];
    return nodes.length === 3 && nodes.every((node) => node.dataset.previewReady === 'true');
  });
  const result = await previews.evaluateAll((nodes) =>
    nodes.map((node) => {
      const video = node.querySelector('video');
      const rect = node.querySelector('rect');
      return {
        seconds: video.currentTime,
        src: video.currentSrc,
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
        viewBox: node.querySelector('svg').getAttribute('viewBox'),
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        region: ['x', 'y', 'width', 'height'].map((name) => rect.getAttribute(name)),
        stroke: rect.getAttribute('stroke-width'),
      };
    }),
  );
  const expected = [Math.min(6, duration / 2), Math.min(42, duration * 0.5), Math.min(82, duration * 0.8)];
  for (const [index, preview] of result.entries()) {
    assert.ok(Math.abs(preview.seconds - expected[index]) < 1 / 30, JSON.stringify(result));
    assert.equal(preview.width, 40);
    assert.equal(preview.height, 24);
    assert.equal(preview.stroke, '1.5');
  }
  assert.equal(new Set(result.map((preview) => preview.src)).size, 1);
  assert.doesNotMatch(await group.innerText(), /Artwork 1|\d+\s*(s|秒)/);
  const ids = await surface
    .getByTestId('review-pending-chat-mark')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.selectionId));
  const geometry = async () =>
    toolbar.evaluate(
      (node, b) => {
        const a = node.getBoundingClientRect();
        return { centerOffset: (a.left + a.right) / 2 - b.x - b.width / 2, height: a.height };
      },
      await surface.getByTestId('review-media-stage').boundingBox(),
    );
  const videoToolbar = await geometry();
  assert.ok(Math.abs(videoToolbar.centerOffset) < 2, JSON.stringify(videoToolbar));
  assert.equal(videoToolbar.height, 36);
  await page.screenshot({ path: path.join(evidence, 'three-places-zh.png') });
  await language('en');
  await toolbar.getByRole('button', { name: 'Circle frame', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'three-places-en.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await group.evaluate((node) => ({
    width: node.clientWidth,
    scrollWidth: node.scrollWidth,
    // Only the chip rows: each thumbnail also draws its own [data-selection-id] region mark inside the button.
    chips: [...node.querySelectorAll('[data-testid="media-selections"] > [data-selection-id]')].map((place) => ({
      width: place.getBoundingClientRect().width,
      height: place.querySelector('button').getBoundingClientRect().height,
    })),
  }));
  assert.ok(mobile.scrollWidth <= mobile.width + 1, JSON.stringify(mobile));
  await page.screenshot({ path: path.join(evidence, 'three-places-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  const last = group.getByRole('button', { name: `Open artwork 1 · Place ${ids[2]}`, exact: true });
  await last.hover();
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  await tip.locator('[data-preview-ready="true"]').waitFor();
  const hoverWidth = await tip
    .getByTestId('media-selection-preview')
    .evaluate((node) => node.getBoundingClientRect().width);
  assert.equal(hoverWidth, 240);
  await page.screenshot({ path: path.join(evidence, 'selected-frame-hover.png') });
  await last.click();
  await page.waitForFunction(
    ({ seconds }) => {
      const video = document.querySelector(
        '[data-testid="artwork-lightbox-owner"] video[data-testid="workspace-content-review-media"]',
      );
      return video && !video.seeking && Math.abs(video.currentTime - seconds) < 1 / 30;
    },
    { seconds: expected[2] },
  );
  await surface
    .locator(`[data-testid="review-pending-chat-mark"][data-selection-id="${ids[2]}"][data-active="true"]`)
    .waitFor();
  await group.getByRole('button', { name: `Remove selection ${ids[2]}`, exact: true }).click();
  await language('zh');
  return {
    previews: result,
    hoverWidth,
    videoToolbar,
    mobile,
    ids,
    expected,
    clickTargetsOriginalFrame: true,
  };
}
