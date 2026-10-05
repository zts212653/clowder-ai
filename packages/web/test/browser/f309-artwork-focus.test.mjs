import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

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

test(
  'F309 artwork focus: default sidecar and explicit large canvas share one editable surface',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-focus-'));
    await mediaFixture(root, 'png');
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
      else console.log(`artwork focus RED evidence: ${root}`);
    });

    await page.goto(host.origin);
    await page.getByTestId('open-artifact-review').click();
    await page.getByTestId('review-media-stage').locator('img').waitFor();
    const workbench = page.getByTestId('f307-experience-workbench');
    assert.equal(await workbench.getAttribute('data-main-area-attention'), '');
    await page.screenshot({ path: path.join(root, 'default-sidecar.png'), fullPage: true });
    await capture(page, '01-default-desktop.png');
    const sidecarImage = await page.getByTestId('review-media-stage').boundingBox();
    assert.ok(
      sidecarImage && sidecarImage.width >= 220 && sidecarImage.height >= 145,
      `Default sidecar artwork must be legible: ${JSON.stringify(sidecarImage)}`,
    );
    await page.getByRole('button', { name: '评论', exact: true }).click();
    const quickPoint = await mediaPoint(page, 0.3, 0.45);
    await page.mouse.click(quickPoint.x, quickPoint.y);
    await page.getByRole('textbox', { name: '评论内容' }).fill('右栏的点位短评 sentinel-sidecar');
    await page.getByRole('button', { name: '保存批注', exact: true }).click();
    await page.getByRole('button', { name: '退出评论', exact: true }).click();
    await page.getByTestId('content-modification-entry').click();
    await page.getByTestId('content-modification-panel').waitFor();
    assert.match(await page.getByTestId('workspace-content-review-surface').textContent(), /修改想法 · 整图/);
    await page.getByRole('button', { name: '收起修改面板' }).click();
    await page.getByRole('button', { name: '放大圈选', exact: true }).click();
    assert.notEqual(await workbench.getAttribute('data-main-area-attention'), '');
    await page.getByRole('button', { name: '取消圈选', exact: true }).waitFor();
    await page.getByTestId('f307-return-from-main-area').click();

    await page.getByRole('button', { name: '放大标注', exact: true }).click();
    assert.notEqual(await workbench.getAttribute('data-main-area-attention'), '');
    await page.getByRole('button', { name: '文字', exact: true }).click();
    const stage = page.getByTestId('review-media-stage');
    const box = await stage.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);
    const editor = page.getByRole('textbox', { name: '标注文字' });
    await editor.fill('尾巴的绒毛 · Make this detail warmer');
    await editor.press('Enter');
    await capture(page, '02-focused-text.png');
    assert.equal(await page.getByTestId('review-local-mark').count(), 1);
    assert.equal(await page.getByRole('button', { name: '选择', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByTestId('review-local-mark').first().locator('tspan').first().click();
    await editor.fill('改成更暖的尾巴绒毛');
    await page.getByRole('button', { name: '移动文字', exact: true }).click();
    const moved = await mediaPoint(page, 0.72, 0.72);
    await page.mouse.click(moved.x, moved.y);
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    assert.match(await page.getByTestId('review-local-mark').textContent(), /改成更暖的尾巴绒毛/);
    await page.getByRole('button', { name: '文字', exact: true }).click();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    assert.equal(await editor.inputValue(), '');
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    await page.getByTestId('f307-return-from-main-area').click();
    assert.equal(await workbench.getAttribute('data-main-area-attention'), '');
    assert.equal(await page.getByTestId('review-local-mark').count(), 1, 'Returning keeps the unsaved text.');
    await page.getByRole('button', { name: '放大标注', exact: true }).click();
    await page.getByRole('button', { name: '完成并保存', exact: true }).click();
    await page.getByTestId('review-saved-mark').waitFor();
    await capture(page, '03-saved-and-readback.png');
    assert.equal(
      await host.reviews
        .read(host.store.listReviewIds('operator')[0], host.human)
        .then((view) => view.review.rounds[0].visualMarks.length),
      1,
    );
    assert.equal(host.starts.length, 0, 'Saving marks or comments does not entrust a Task.');
    await page.getByTestId('f307-return-from-main-area').click();
    assert.equal(await workbench.getAttribute('data-main-area-attention'), '');
    await page.getByTestId('review-saved-mark').waitFor();
    assert.deepEqual(errors, []);
  },
);

test('F309 artwork focus: 390px keeps the same canvas and save action reachable', { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-mobile-'));
  await mediaFixture(root, 'png');
  const host = await startReviewHost(root, 'image/png');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  t.after(async () => {
    await page.screenshot({ path: path.join(root, 'last.png'), fullPage: true }).catch(() => {});
    await browser.close();
    await host.close();
    if (t.passed) await rm(root, { recursive: true, force: true });
    else console.log(`artwork mobile evidence: ${root}`);
  });
  await page.goto(host.origin);
  await page.getByTestId('open-artifact-review').click();
  await page.getByRole('button', { name: '放大标注', exact: true }).click();
  await page.getByRole('button', { name: '文字', exact: true }).click();
  const at = await mediaPoint(page, 0.32, 0.4);
  await page.mouse.click(at.x, at.y);
  await page.getByRole('textbox', { name: '标注文字' }).fill('窄屏仍能完成');
  await page.getByRole('button', { name: '完成文字', exact: true }).click();
  const save = await page.getByRole('button', { name: '完成并保存', exact: true }).boundingBox();
  assert.ok(save && save.x >= 0 && save.x + save.width <= 390 && save.y + save.height <= 844);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.getByRole('button', { name: '完成并保存', exact: true }).click();
  await page.getByTestId('review-saved-mark').waitFor();
  await capture(page, '07-mobile-390.png');
});

test('F309 artwork focus: a late save receipt preserves marks drawn while saving', { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-late-save-'));
  await mediaFixture(root, 'png');
  const host = await startReviewHost(root, 'image/png');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(async () => {
    await page.screenshot({ path: path.join(root, 'last.png'), fullPage: true }).catch(() => {});
    await browser.close();
    await host.close();
    if (t.passed) await rm(root, { recursive: true, force: true });
    else console.log(`artwork late-save evidence: ${root}`);
  });
  await page.goto(host.origin);
  await page.getByTestId('open-artifact-review').click();
  await page.getByRole('button', { name: '放大标注', exact: true }).click();
  await page.getByRole('button', { name: '画笔', exact: true }).click();
  const draw = async (x) => {
    const from = await mediaPoint(page, x, 0.3),
      to = await mediaPoint(page, x + 0.12, 0.43);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
  };
  await draw(0.2);
  await page.getByTestId('review-local-mark').first().waitFor();
  let release;
  let admitted;
  const sent = new Promise((resolve) => {
    admitted = resolve;
  });
  await page.route('**/actions', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action?.kind !== 'add_visual_marks' || release === false) return route.continue();
    const response = await route.fetch();
    admitted();
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
    release = false;
  });
  await page.getByRole('button', { name: '完成并保存', exact: true }).click();
  await sent;
  await draw(0.56);
  release();
  await page.getByText('本次标记已保存。').waitFor();
  assert.equal(await page.getByRole('region', { name: '作品画布工具' }).getAttribute('data-review-mode'), 'markup');
  assert.equal(await page.getByTestId('review-local-mark').count(), 1, 'Only the later drawing stays local.');
  assert.equal(await page.getByTestId('review-saved-markup-layer').getByTestId('review-saved-mark').count(), 1);
  await page.getByRole('button', { name: '完成并保存', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="review-saved-markup-layer"] [data-testid="review-saved-mark"]')
        .length === 2,
  );
  const view = await host.reviews.read(host.store.listReviewIds('operator')[0], host.human);
  assert.equal(view.review.rounds[0].visualMarks.length, 2);
});

test(
  'F309 artwork focus: unknown save preserves the draft and retries the original operation once',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-unknown-save-'));
    await mediaFixture(root, 'png');
    const host = await startReviewHost(root, 'image/png');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    t.after(async () => {
      await page.screenshot({ path: path.join(root, 'last.png'), fullPage: true }).catch(() => {});
      await browser.close();
      await host.close();
      if (t.passed) await rm(root, { recursive: true, force: true });
      else console.log(`artwork unknown-save evidence: ${root}`);
    });
    await page.goto(host.origin);
    await page.getByTestId('open-artifact-review').click();
    await page.getByRole('button', { name: '放大标注', exact: true }).click();
    await page.getByRole('button', { name: '文字', exact: true }).click();
    const at = await mediaPoint(page, 0.42, 0.4);
    await page.mouse.click(at.x, at.y);
    await page.getByRole('textbox', { name: '标注文字' }).fill('原始快照');
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    let failed = false;
    await page.route('**/actions', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (!failed && body.action?.kind === 'add_visual_marks') {
        failed = true;
        return route.fulfill({ status: 503, body: 'temporary uncertainty' });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: '完成并保存', exact: true }).click();
    await page.getByText('保存结果待核对；草稿仍保留。').waitFor();
    assert.equal(await page.getByTestId('review-local-mark').count(), 1);
    const reviewId = host.store.listReviewIds('operator')[0];
    assert.equal(((await host.reviews.read(reviewId, host.human)).review.rounds[0].visualMarks ?? []).length, 0);
    await page.getByTestId('review-local-mark').click();
    await page.getByRole('textbox', { name: '标注文字' }).fill('未知后继续修改');
    await page.getByRole('button', { name: '移动文字', exact: true }).click();
    const moved = await mediaPoint(page, 0.76, 0.82);
    await page.mouse.click(moved.x, moved.y);
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    assert.match(await page.getByTestId('review-local-mark').textContent(), /未知后继续修改/);
    await page.getByRole('button', { name: '核对并重试保存', exact: true }).click();
    await page.getByTestId('review-saved-markup-layer').getByTestId('review-saved-mark').waitFor();
    assert.equal((await host.reviews.read(reviewId, host.human)).review.rounds[0].visualMarks.length, 1);
    await page.getByTestId('review-local-mark').waitFor({ timeout: 3000 });
    assert.match(await page.getByTestId('review-local-mark').textContent(), /未知后继续修改/);
    await page.getByTestId('review-local-mark').click();
    assert.equal(await page.getByRole('textbox', { name: '标注文字' }).inputValue(), '未知后继续修改');
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    await page.getByRole('button', { name: '完成并保存', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="review-saved-markup-layer"] [data-testid="review-saved-mark"]')
          .length === 2,
    );
    const drawings = (await host.reviews.read(reviewId, host.human)).review.rounds[0].visualMarks.map(
      (mark) => mark.drawing,
    );
    assert.equal(drawings[0].text, '原始快照');
    assert.equal(drawings[1].text, '未知后继续修改');
    assert.notEqual(drawings[0].id, drawings[1].id);
    assert.ok(
      drawings[1].at.x > drawings[0].at.x && drawings[1].at.y > drawings[0].at.y,
      `Later draft should keep its moved point: ${JSON.stringify(drawings)}`,
    );
    assert.equal(failed, true);
  },
);

test(
  'F309 artwork focus: an open text editor survives settlement of its original mark',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-open-editor-receipt-'));
    await mediaFixture(root, 'png');
    const host = await startReviewHost(root, 'image/png');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    t.after(async () => {
      await page.screenshot({ path: path.join(root, 'last.png'), fullPage: true }).catch(() => {});
      await browser.close();
      await host.close();
      if (t.passed) await rm(root, { recursive: true, force: true });
      else console.log(`artwork open-editor receipt evidence: ${root}`);
    });
    await page.goto(host.origin);
    await page.getByTestId('open-artifact-review').click();
    await page.getByRole('button', { name: '放大标注', exact: true }).click();
    await page.getByRole('button', { name: '文字', exact: true }).click();
    const at = await mediaPoint(page, 0.42, 0.4);
    await page.mouse.click(at.x, at.y);
    await page.getByRole('textbox', { name: '标注文字' }).fill('原始快照');
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    let failed = false;
    await page.route('**/actions', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (!failed && body.action?.kind === 'add_visual_marks') {
        failed = true;
        return route.fulfill({ status: 503, body: 'temporary uncertainty' });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: '完成并保存', exact: true }).click();
    await page.getByText('保存结果待核对；草稿仍保留。').waitFor();
    await page.getByTestId('review-local-mark').click();
    const editor = page.getByRole('textbox', { name: '标注文字' });
    await editor.fill('回执到达时仍在编辑');
    await page.getByRole('button', { name: '移动文字', exact: true }).click();
    const moved = await mediaPoint(page, 0.76, 0.82);
    await page.mouse.click(moved.x, moved.y);
    const reviewId = host.store.listReviewIds('operator')[0];
    await page.getByRole('button', { name: '核对并重试保存', exact: true }).click();
    await page.getByTestId('review-saved-markup-layer').getByTestId('review-saved-mark').waitFor();
    assert.equal(await editor.inputValue(), '回执到达时仍在编辑');
    await page.reload();
    await page.getByTestId('open-artifact-review').click();
    await page.getByRole('button', { name: '放大标注', exact: true }).click();
    assert.equal(await editor.inputValue(), '回执到达时仍在编辑', 'The open editor recovers after a reload.');
    await page.getByRole('button', { name: '完成文字', exact: true }).click();
    assert.equal(await page.getByTestId('review-local-mark').count(), 1, 'Later text remains a visible local draft.');
    assert.match(await page.getByTestId('review-local-mark').textContent(), /回执到达时仍在编辑/);
    await page.getByRole('button', { name: '完成并保存', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="review-saved-markup-layer"] [data-testid="review-saved-mark"]')
          .length === 2,
    );
    const drawings = (await host.reviews.read(reviewId, host.human)).review.rounds[0].visualMarks.map(
      (mark) => mark.drawing,
    );
    assert.equal(drawings[0].text, '原始快照');
    assert.equal(drawings[1].text, '回执到达时仍在编辑');
    assert.notEqual(drawings[0].id, drawings[1].id);
    assert.ok(drawings[1].at.x > drawings[0].at.x && drawings[1].at.y > drawings[0].at.y);
    assert.equal(failed, true);
  },
);
