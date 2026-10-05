import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';

const sharp = createRequire(new URL('../../../api/package.json', import.meta.url))('sharp');
const evidenceRoot = process.env.F309_BROWSER_EVIDENCE_DIR ? path.resolve(process.env.F309_BROWSER_EVIDENCE_DIR) : null;
async function capture(page, name) {
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: path.join(evidenceRoot, name), fullPage: true });
}

async function mediaPoint(page, x, y) {
  return page
    .getByTestId('review-media-stage')
    .locator('svg[aria-label="图片或视频上的批注"]')
    .evaluate(
      (svg, point) =>
        new DOMPoint(svg.viewBox.baseVal.width * point.x, svg.viewBox.baseVal.height * point.y)
          .matrixTransform(svg.getScreenCTM())
          .toJSON(),
      { x, y },
    );
}

for (const { width, height } of [
  { width: 1024, height: 768 },
  { width: 4096, height: 2304 },
  { width: 2304, height: 4096 },
]) {
  test(
    `F309 artwork focus: ${width}×${height} text remains legible and zoomed anchors use media coordinates`,
    { timeout: 90000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-resolution-'));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#eee6d9"/><rect x="12%" y="18%" width="70%" height="60%" fill="#618677"/><text x="16%" y="55%" fill="#fff" font-size="${Math.round(width / 18)}">CAT CAFE ARTWORK</text></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(path.join(root, 'review-input.png'));
      const host = await startReviewHost(root, 'image/png');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      t.after(async () => {
        await page.screenshot({ path: path.join(root, 'last.png'), fullPage: true }).catch(() => {});
        await browser.close();
        await host.close();
        if (t.passed) await rm(root, { recursive: true, force: true });
        else console.log(`artwork resolution evidence: ${root}`);
      });
      await page.goto(host.origin);
      await page.getByTestId('open-artifact-review').click();
      await page.getByRole('button', { name: '放大标注', exact: true }).click();
      await page.getByRole('button', { name: '文字', exact: true }).click();
      const at = await mediaPoint(page, 0.22, 0.32);
      await page.mouse.click(at.x, at.y);
      const editor = page.getByRole('textbox', { name: '标注文字' });
      const content =
        '尾巴绒毛要更清楚 · Please preserve the little highlights and warm colors in this detailed part of the picture';
      await editor.fill(content);
      await editor.evaluate((input) =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })),
      );
      assert.equal(await page.getByTestId('review-local-mark').count(), 0, 'IME Enter must not commit.');
      await editor.press('Enter');
      const local = page.getByTestId('review-local-mark').first();
      await local.waitFor();
      if (height > width) {
        const lines = await local.locator('tspan').allTextContents();
        assert.ok(
          lines.some((line) => line.includes('Please')),
          `English words should stay whole: ${JSON.stringify(lines)}`,
        );
      }
      const rendered = await local.locator('text').boundingBox();
      assert.ok(rendered && rendered.height >= 14, `The text must be readable on screen: ${JSON.stringify(rendered)}`);
      const stage = await page.getByTestId('review-media-stage').boundingBox();
      assert.ok(
        stage && rendered.x >= stage.x - 2 && rendered.x + rendered.width <= stage.x + stage.width + 2,
        `Long text must fit the picture: ${JSON.stringify({ rendered, stage })}`,
      );
      await page.getByRole('button', { name: '文字', exact: true }).click();
      const corner = await mediaPoint(page, 0.96, 0.95);
      await page.mouse.click(corner.x, corner.y);
      const cornerText = `${'靠右下角的长中文'.repeat(20)} ${'LongEnglishWords '.repeat(4)}`.slice(0, 240);
      await page.getByRole('textbox', { name: '标注文字' }).fill(cornerText);
      await page.getByRole('button', { name: '完成文字', exact: true }).click();
      const cornerMark = page.getByTestId('review-local-mark').last();
      const cornerLines = await cornerMark.locator('tspan').allTextContents();
      assert.equal(cornerLines.join('').replace(/\s+/g, ''), cornerText.replace(/\s+/g, ''));
      const cornerBounds = await cornerMark.locator('text').boundingBox();
      assert.ok(
        cornerBounds &&
          cornerBounds.height / cornerLines.length >= 14 &&
          cornerBounds.x >= stage.x - 2 &&
          cornerBounds.y >= stage.y - 2 &&
          cornerBounds.x + cornerBounds.width <= stage.x + stage.width + 2 &&
          cornerBounds.y + cornerBounds.height <= stage.y + stage.height + 2,
        `Corner text must remain wholly readable: ${JSON.stringify({ cornerBounds, stage })}`,
      );
      await page.getByRole('button', { name: '完成并保存', exact: true }).click();
      await page.getByTestId('review-saved-mark').first().waitFor();
      await capture(page, `${width}x${height}-saved-text.png`);
      const reviewId = host.store.listReviewIds('operator')[0];
      const view = await host.reviews.read(reviewId, host.human);
      const drawing = view.review.rounds[0].visualMarks[0].drawing;
      assert.equal(drawing.text, content);
      if (width >= 2304) assert.ok(drawing.fontSize > 48, `4k text needs media-space sizing: ${drawing.fontSize}`);

      await page.getByRole('button', { name: '放大作品', exact: true }).click();
      await page.getByRole('button', { name: '放大作品', exact: true }).click();
      const zoomBeforeWheel = await page.getByLabel('当前缩放').textContent();
      const wheelStage = await page.getByTestId('review-media-stage').boundingBox();
      await page.mouse.move(wheelStage.x + wheelStage.width / 2, wheelStage.y + wheelStage.height / 2);
      await page.mouse.wheel(0, -180);
      await page.waitForFunction(
        (before) => document.querySelector('output[aria-label="当前缩放"]')?.textContent !== before,
        zoomBeforeWheel,
        { timeout: 3000 },
      );
      assert.notEqual(await page.getByLabel('当前缩放').textContent(), zoomBeforeWheel);
      await page.getByRole('button', { name: '平移', exact: true }).click();
      const before = await page.getByTestId('review-media-stage').boundingBox();
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 + 24, before.y + before.height / 2 + 18);
      await page.mouse.up();
      await page.getByRole('button', { name: '平移', exact: true }).click();
      await page.getByRole('button', { name: '评论', exact: true }).click();
      const picture = await page.getByRole('region', { name: '作品画面' }).boundingBox();
      const point = { x: picture.x + picture.width * 0.55, y: picture.y + picture.height * 0.32 };
      const expected = await page
        .getByTestId('review-media-stage')
        .locator('svg[aria-label="图片或视频上的批注"]')
        .evaluate(
          (svg, screen) => new DOMPoint(screen.x, screen.y).matrixTransform(svg.getScreenCTM().inverse()).toJSON(),
          point,
        );
      assert.ok(expected.x > 0 && expected.x < width && expected.y > 0 && expected.y < height);
      await page.mouse.click(point.x, point.y);
      await page.getByRole('textbox', { name: '评论内容' }).fill(`缩放后锚点 ${width}×${height}`);
      await page.getByRole('button', { name: '保存批注', exact: true }).click();
      await page.getByTestId('review-canvas-annotation-mark').waitFor();
      const latest = await host.reviews.read(reviewId, host.human);
      const anchor = latest.review.rounds[0].annotations.at(-1).anchor;
      assert.equal(anchor.kind, 'image-point');
      assert.ok(
        Math.abs(anchor.x - expected.x) < 3 && Math.abs(anchor.y - expected.y) < 3,
        `Zoomed anchor must use original-media coordinates: ${JSON.stringify(anchor)}`,
      );
      assert.deepEqual(errors, []);
    },
  );
}
