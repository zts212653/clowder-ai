import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { fulfillFixtureApi } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';

const evidenceRoot = process.env.F309_BROWSER_EVIDENCE_DIR;

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

async function assertArtworkAndForm(page, label, defaultHeight) {
  const artwork = await page.getByTestId('workspace-review-artwork').boundingBox();
  const image = await page.getByTestId('workspace-content-review-media').boundingBox();
  const input = await page.getByLabel('修改说明', { exact: true }).boundingBox();
  const submit = await page.getByTestId('content-modification-submit').boundingBox();
  assert.ok(artwork && image && input && submit, `${label}: missing artwork or form geometry`);
  assert.ok(
    image.height >= Math.max(200, defaultHeight * 0.5),
    `${label}: modification must retain a readable image; default=${defaultHeight}, expanded=${JSON.stringify(image)}`,
  );
  assert.ok(input.y >= 0 && input.y + input.height <= page.viewportSize().height, `${label}: input is unreachable`);
  assert.ok(
    submit.y >= 0 && submit.y + submit.height <= page.viewportSize().height,
    `${label}: confirmation is unreachable`,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
}

async function openOrdinaryImage(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-chat-container]').waitFor();
  await ensureWorkspaceOpen(page);
  const home = page.getByTestId('workspace-launcher-home');
  await home.getByTestId('workspace-launcher-search').fill('cover');
  await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
  const image = page.getByTestId('workspace-content-review-media');
  await image.waitFor();
  return (await image.boundingBox())?.height ?? 0;
}

async function selectRegion(page, keepCommentDraft) {
  await page.getByRole('button', { name: '圈选区域', exact: true }).click();
  const start = await mediaPoint(page, 0.3, 0.3);
  const end = await mediaPoint(page, 0.7, 0.65);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.getByText('修改想法 · 当前选区').waitFor();
  if (keepCommentDraft) await page.getByRole('textbox', { name: '评论内容' }).fill('尚未保存的短评也要保留');
}

async function confirmRegionDraftSurvives(page) {
  await page.getByRole('button', { name: '收起修改面板' }).click();
  await page.getByRole('button', { name: '评论', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '评论内容' }).inputValue(), '尚未保存的短评也要保留');
}

async function fillModification(page, scope, label) {
  await page.getByTestId('content-modification-entry').click();
  await page.getByTestId('content-modification-panel').waitFor();
  if (scope === 'selected region') {
    assert.equal(await page.getByRole('dialog', { name: '评论这处画面' }).count(), 0);
    await page.getByText('将按作品中选定的位置或视频范围修改。').waitFor();
  }
  await page.getByLabel('修改目标猫').selectOption('codex-terra');
  await page.getByLabel('修改执行对话').selectOption(THREAD_ID);
  const input = page.getByLabel('修改说明', { exact: true });
  await input.fill(`${label}: keep the eyes visible while changing the background`);
  assert.equal(await page.getByTestId('content-modification-submit').isEnabled(), true);
}

async function confirmFormControlsReachable(page, viewport, scope) {
  for (const name of ['修改目标猫', '修改执行对话']) {
    const control = page.getByLabel(name);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `${name} must be reachable`);
  }
  await capture(page, viewport, scope, 'choices');
  await page.getByLabel('修改说明', { exact: true }).scrollIntoViewIfNeeded();
  await page.getByTestId('content-modification-submit').scrollIntoViewIfNeeded();
  await capture(page, viewport, scope, 'confirmation');
}

async function capture(page, viewport, scope, step) {
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({
    path: `${evidenceRoot}/modification-${viewport.width}-${scope.replace(' ', '-')}-${step}.png`,
    fullPage: true,
  });
}

export function registerOrdinaryModificationJourney(suite) {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const scope of ['whole image', 'selected region']) {
      test(
        `ordinary Workspace modification keeps artwork and form usable at ${viewport.width}px with ${scope}`,
        { timeout: 90_000 },
        async () => {
          const { browser, baseUrl } = suite();
          const context = await browser.newContext({ viewport });
          await context.addInitScript(() => window.localStorage.clear());
          const page = await context.newPage();
          const state = createReviewState();
          const label = `${viewport.width}px ${scope}`;
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.route('**/api/**', (route) => fulfillFixtureApi(route, state, []));
          try {
            const defaultHeight = await openOrdinaryImage(page, baseUrl);
            assert.ok(defaultHeight >= 200, `${label}: default image must already be readable`);
            if (scope === 'selected region') await selectRegion(page, viewport.width === 1280);
            await fillModification(page, scope, label);
            await confirmFormControlsReachable(page, viewport, scope);
            await assertArtworkAndForm(page, label, defaultHeight);
            if (scope === 'selected region' && viewport.width === 1280) await confirmRegionDraftSurvives(page);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        },
      );
    }
  }
}
