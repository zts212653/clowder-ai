import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../ppt-forge/node_modules/playwright/index.mjs';
import { openReviewPanel, selectReviewMode } from './f309-artwork-controls.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const receipt = JSON.parse(await readFile(path.join(repository, 'var/f309-artwork-preview/current.json'), 'utf8'));
const evidence = path.join(receipt.root, `browser-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 920 } });
page.setDefaultTimeout(10000);
const errors = [];
const checks = [];
page.on('pageerror', (error) => errors.push(error.message));
const sentinel = `书架上的星星灯再暖一点，保留窗外的夜色。体验检查 ${Date.now()}`;
const markupText = `保留这片暖光 ${Date.now()}`;
async function shot(name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
}
async function point(x, y) {
  const stage = page.getByTestId('review-media-stage');
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  assert.ok(box);
  const size = await stage.locator('img').evaluate((img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
  const scale = Math.min(box.width / size.width, box.height / size.height);
  return {
    x: box.x + (box.width - size.width * scale) / 2 + size.width * x * scale,
    y: box.y + (box.height - size.height * scale) / 2 + size.height * y * scale,
  };
}
try {
  await page.goto(receipt.origin);
  assert.equal(await page.locator('html').getAttribute('data-cat-cafe-build-revision'), receipt.clientRevision);
  await page.getByTestId('open-artifact-review').click();
  await page.locator('[data-testid="review-media-stage"] img').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="review-media-stage"] img')?.naturalWidth > 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await shot('01-default-desktop');
  checks.push('Real Schedule action opens the real F307 ArtifactReviewSurface with the first-party room illustration.');

  await selectReviewMode(page, 'markup');
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.getByRole('textbox', { name: '标注文字', exact: true }).fill(markupText);
  const label = await point(0.4, 0.22);
  await page.mouse.click(label.x, label.y);
  await page.getByTestId('review-local-mark').waitFor();
  assert.ok((await page.getByTestId('review-local-mark').textContent()).includes(markupText));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await page.getByTestId('review-local-mark').count(), 0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByTestId('review-local-mark').waitFor();
  await shot('02-markup-desktop');
  await page.reload();
  await selectReviewMode(page, 'markup');
  await page.getByTestId('review-local-mark').waitFor();
  assert.ok((await page.getByTestId('review-local-mark').textContent()).includes(markupText));
  checks.push(
    'Unscripted text entered through markup controls survives undo/redo and browser reload as a local draft.',
  );

  await selectReviewMode(page, 'comment');
  const from = await point(0.68, 0.61);
  const to = await point(0.8, 0.77);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: '新增标注意见' }).fill(sentinel);
  await page.reload();
  assert.equal(await page.getByRole('textbox', { name: '新增标注意见' }).inputValue(), sentinel);
  await page.getByRole('button', { name: '保存评论', exact: true }).click();
  await page.getByTestId('review-comment').filter({ hasText: sentinel }).waitFor();
  await page.reload();
  await openReviewPanel(page, 'comments');
  await page.getByTestId('review-comment').filter({ hasText: sentinel }).waitFor();
  await selectReviewMode(page, 'comment');
  await page.getByTestId('review-canvas-annotation-mark').last().click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'review-comment');
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark',
  );
  await shot('03-comment-desktop');
  checks.push(
    'A new region comment survives draft reload, real owner submission and a second reload; its marker opens the same discussion and Escape returns to that marker.',
  );

  await selectReviewMode(page, 'view');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await shot('04-default-390');
  await selectReviewMode(page, 'markup');
  await page.getByTestId('review-local-mark').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await shot('05-markup-390');
  checks.push('390px view and markup modes remain operable without horizontal page overflow.');

  await page.locator('html').evaluate((html) => html.setAttribute('data-theme', 'dark'));
  await shot('06-markup-dark-390');
  await page.getByLabel('形状', { exact: true }).click();
  await page.getByRole('button', { name: '箭头', exact: true }).click();
  await page.getByLabel('颜色与线条', { exact: true }).click();
  await page.getByRole('button', { name: '选择颜色 #3478c7', exact: true }).click();
  await page.locator('html').evaluate((html) => html.removeAttribute('data-theme'));
  await selectReviewMode(page, 'comment');
  const narrowFrom = await point(0.22, 0.35);
  const narrowTo = await point(0.4, 0.7);
  await page.mouse.move(narrowFrom.x, narrowFrom.y);
  await page.mouse.down();
  await page.mouse.move(narrowTo.x, narrowTo.y, { steps: 4 });
  await page.mouse.up();
  const popup = page.getByTestId('review-comment-popover');
  await popup.waitFor();
  const popupBox = await popup.boundingBox();
  assert.ok(popupBox && popupBox.y >= 0 && popupBox.y + popupBox.height <= 900);
  await shot('07-comment-390');
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  checks.push(
    'Dark/narrow controls, shape and color menus, and an in-viewport comment popup work through actual input.',
  );

  await page.setViewportSize({ width: 1280, height: 920 });
  await page.getByRole('button', { name: '← 回到原处', exact: true }).click();
  await page.getByTestId('product-schedule-panel').waitFor();
  checks.push('Return goes back to the original Schedule owner surface.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, evidence, clientRevision: receipt.clientRevision, checks }));
} catch (error) {
  await shot('failure');
  throw error;
} finally {
  await writeFile(
    path.join(evidence, 'journey.json'),
    `${JSON.stringify({ receipt, sentinel, markupText, checks, errors }, null, 2)}\n`,
  );
  await browser.close();
}
