import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { fulfillFixtureApi, ordinaryVideoFixture } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';

const evidenceRoot = process.env.F309_BROWSER_EVIDENCE_DIR;

async function presentFrame(page, seconds) {
  await page.getByTestId('workspace-content-review-media').evaluate((video, time) => {
    window.__f309ModificationFrames = [];
    const capture = (_now, frame) => {
      window.__f309ModificationFrames.push(frame.mediaTime);
      video.requestVideoFrameCallback(capture);
    };
    video.requestVideoFrameCallback(capture);
    video.pause();
    video.currentTime = time;
  }, seconds);
  await page.waitForFunction(
    (time) =>
      window.__f309ModificationFrames.some((shown) => Math.abs(shown - time) < 0.005) &&
      !document.querySelector('[data-testid="workspace-content-review-media"]').seeking,
    seconds,
  );
}

async function mediaPoint(page, x, y) {
  return page
    .getByTestId('review-media-stage')
    .locator('svg[aria-label="图片或视频上的批注"]')
    .evaluate(
      (svg, point) => {
        const location = new DOMPoint(
          svg.viewBox.baseVal.width * point.x,
          svg.viewBox.baseVal.height * point.y,
        ).matrixTransform(svg.getScreenCTM());
        return { x: location.x, y: location.y };
      },
      { x, y },
    );
}

async function selectPresentedFrame(page) {
  await presentFrame(page, 0.4);
  const select = page.getByRole('button', { name: '圈出这帧画面', exact: true });
  await select.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '圈出这帧画面');
    return button && !button.disabled;
  });
  await select.click();
  const start = await mediaPoint(page, 0.3, 0.3);
  const end = await mediaPoint(page, 0.7, 0.65);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.getByText('修改想法 · 当前选区').waitFor();
  await page.getByRole('textbox', { name: '评论内容' }).fill('视频帧上的短评草稿不能丢');
}

async function visibleControl(locator, label, viewport) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(
    box && box.y >= 0 && box.y + box.height <= viewport.height,
    `${label} must be reachable: ${JSON.stringify({ box, viewport })}`,
  );
}

async function capture(page, viewport, scope, step) {
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({
    path: `${evidenceRoot}/video-modification-${viewport.width}-${scope}-${step}.png`,
    fullPage: true,
  });
}

async function openOrdinaryVideo(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-chat-container]').waitFor();
  await ensureWorkspaceOpen(page);
  const home = page.getByTestId('workspace-launcher-home');
  await home.getByTestId('workspace-launcher-search').fill('clip');
  await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
  const video = page.getByTestId('workspace-content-review-media');
  await video.waitFor();
  await video.evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        if (element.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
        element.addEventListener('loadedmetadata', resolve, { once: true });
        element.addEventListener('error', () => reject(new Error('ordinary MP4 failed to load')), { once: true });
      }),
  );
  const defaultHeight = (await video.boundingBox())?.height ?? 0;
  assert.ok(defaultHeight >= 200, `default video must be readable: ${defaultHeight}`);
  return { video, defaultHeight };
}

async function fillVideoModification(page, scope) {
  if (scope === 'frame-region') await selectPresentedFrame(page);
  await page.getByTestId('content-modification-entry').click();
  await page.getByTestId('content-modification-panel').waitFor();
  if (scope === 'frame-region') {
    assert.equal(await page.getByRole('dialog', { name: '评论这处画面' }).count(), 0);
    await page.getByText('将按作品中选定的位置或视频范围修改。').waitFor();
  }
  await page.getByLabel('修改目标猫').selectOption('codex-terra');
  await page.getByLabel('修改执行对话').selectOption(THREAD_ID);
  await page.getByLabel('修改说明', { exact: true }).fill(`${scope}: keep this video frame readable`);
}

async function assertReadableVideo(page, video, defaultHeight, label) {
  const media = await page.locator('section[aria-label="作品画面"]').boundingBox();
  const expanded = await video.boundingBox();
  assert.ok(media && expanded, 'video and media stage must be present');
  assert.ok(
    expanded.height >= Math.max(200, defaultHeight * 0.5) && media.height >= expanded.height,
    `${label}: default=${defaultHeight}, expanded=${JSON.stringify(expanded)}, media=${JSON.stringify(media)}`,
  );
}

async function assertNoticeDoesNotStealFrame(page, video, defaultHeight, viewport) {
  // Recovery and draft notices are siblings of the media, so extra message height must not consume its frame.
  await page.getByTestId('workspace-review-artwork').evaluate((artwork) => {
    const notice = document.createElement('output');
    notice.textContent = '原请求尚在核对，请保留草稿。';
    notice.style.minHeight = '96px';
    artwork.prepend(notice);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertReadableVideo(page, video, defaultHeight, 'a taller recovery notice must not shrink the video');
  await visibleControl(page.getByTestId('content-modification-submit'), 'confirmation with notice', viewport);
}

async function runVideoModification(suite, viewport, scope) {
  const { browser, baseUrl } = suite();
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => window.localStorage.clear());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = createReviewState(await ordinaryVideoFixture());
  await page.route('**/api/**', (route) => fulfillFixtureApi(route, state, []));
  try {
    const { video, defaultHeight } = await openOrdinaryVideo(page, baseUrl);
    await fillVideoModification(page, scope);
    await video.scrollIntoViewIfNeeded();
    await capture(page, viewport, scope, 'media');
    for (const name of ['片段起点', '片段终点', '修改目标猫', '修改执行对话', '修改说明'])
      await visibleControl(page.getByLabel(name, { exact: true }), name, viewport);
    await visibleControl(page.getByTestId('content-modification-submit'), 'confirmation', viewport);
    await capture(page, viewport, scope, 'confirmation');
    await assertReadableVideo(page, video, defaultHeight, 'modification must retain a readable video');
    assert.equal(await page.getByTestId('content-modification-submit').isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await assertNoticeDoesNotStealFrame(page, video, defaultHeight, viewport);
    if (scope === 'frame-region') {
      await page.getByRole('button', { name: '收起修改面板' }).click();
      await page.getByRole('button', { name: '评论', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: '评论内容' }).inputValue(), '视频帧上的短评草稿不能丢');
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

export function registerOrdinaryVideoModificationJourney(suite) {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const scope of ['whole', 'frame-region']) {
      test(
        `ordinary Workspace MP4 modification keeps the frame and controls usable at ${viewport.width}px with ${scope}`,
        { timeout: 90_000 },
        () => runVideoModification(suite, viewport, scope),
      );
    }
  }
}
