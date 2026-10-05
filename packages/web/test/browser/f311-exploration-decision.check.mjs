import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { refIdentity } from '../../../shared/dist/index.js';

const origin = 'http://127.0.0.1:5188';
const programId = 'evolution-program:31103110311031103110311031103110';
const url = `${origin}/thread/thread-f311-workspace-contract?evolutionProgram=${encodeURIComponent(programId)}&evolutionView=judgment&mockExploration=1`;
const output = '/tmp/cat-cafe-evidence/f311-exploration-decision';
await mkdir(output, { recursive: true });
const catalog = await (
  await fetch(`${origin}/api/capability-evolution/programs/${encodeURIComponent(programId)}/exploration`)
).json();
const node = (id) => catalog.nodes.find((n) => n.title.startsWith(`${id} ·`));
const run = (id) => catalog.experiments.find((n) => n.title.startsWith(`${id} ·`));
const report = { url, checks: [], errors: [], writes: [] };
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 416, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => report.errors.push(e.message));
    page.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/capability-evolution/')) report.writes.push(r.url());
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const host = page.getByTestId('mock-exploration-host');
      await host.getByRole('button', { name: '探索进化', exact: true }).click({ timeout: 60000 });
      if (await host.getByRole('button', { name: '展开阅读 →', exact: true }).count())
        await host.getByRole('button', { name: '展开阅读 →', exact: true }).click();
      const work = page.getByTestId('evolution-exploration-workspace');
      await work.waitFor();
      const title = page.locator('.evolution-title');
      const font = await title.evaluate((el) => getComputedStyle(el).fontSize);
      await page.getByRole('tab', { name: '更改历史', exact: true }).click();
      assert.equal(await title.evaluate((el) => getComputedStyle(el).fontSize), font);
      await page.getByRole('tab', { name: '探索工作面', exact: true }).click();
      await work.waitFor();
      async function choose(label, value) {
        if (label === '选择阅读版本' && !(await work.getByLabel(label).isVisible())) {
          const title = catalog.nodes.find((item) => refIdentity(item.nodeRef) === value).title;
          await work.getByRole('button', { name: `阅读 ${title}`, exact: true }).click();
          return;
        }
        if (label !== '选择阅读版本') {
          const picker = work.locator('.exploration-run-picker');
          if ((await picker.getAttribute('open')) === null) await picker.locator('summary').click();
        }
        await work.getByLabel(label).selectOption(value);
      }
      assert.equal(
        await work.locator('.exploration-decision-main').count(),
        1,
        'Selection, result and cases need one stable reading surface',
      );
      await choose('选择阅读版本', refIdentity(node('V2').nodeRef));
      await work.getByRole('button', { name: '改善 2', exact: true }).waitFor();
      assert.equal(
        await work.getByLabel('选择本版实验').inputValue(),
        refIdentity(run('X2').experimentRef),
        'Version opens recorded evidence before its later aborted run',
      );
      await work.locator('.exploration-run-notice summary').click();
      await work
        .locator('.exploration-run-notice')
        .getByRole('button', { name: run('X3').title, exact: true })
        .click();
      await work.getByText(/本轮未完成有效测量/).waitFor();
      await choose('选择本版实验', refIdentity(run('X2').experimentRef));
      await work.getByRole('button', { name: '改善 2', exact: true }).waitFor();
      assert.equal(await work.getByLabel('选择对照实验').inputValue(), refIdentity(run('X1').experimentRef));
      await work.getByRole('button', { name: '退步 1', exact: true }).click();
      await work.getByRole('heading', { name: '右侧更宽 · 模拟', exact: true }).waitFor();
      const pairedHeaders = await work.locator('.exploration-outcome > header').all();
      assert.equal(pairedHeaders.length, 2);
      for (const header of pairedHeaders) {
        const box = await header.boundingBox();
        assert(box && box.y >= 0 && box.y + box.height <= 900, 'Both case verdicts must be visible after filtering');
      }
      assert.equal(
        await work
          .locator('.exploration-output-reading')
          .getByText(/\{"truth"/)
          .count(),
        0,
      );
      await page.screenshot({ path: `${output}/regression-${width}.png` });
      await work.locator('.exploration-decision-main').screenshot({ path: `${output}/focus-${width}.png` });
      const before = await work.locator('.exploration-pair-focus').boundingBox();
      await work.getByRole('button', { name: '改善 2', exact: true }).click();
      await work.getByRole('heading', { name: '左侧较远 · 模拟', exact: true }).waitFor();
      const after = await work.locator('.exploration-pair-focus').boundingBox();
      assert(Math.abs(after.y - before.y) < 100, 'Case filtering should update the same reading area');
      await work.getByRole('button', { name: '评估与观测', exact: true }).click();
      await work.getByText('展开环境、量尺与 GT 来源', { exact: true }).first().click();
      await work
        .getByText(/原来的|50Hz/)
        .first()
        .waitFor();
      await work.getByRole('button', { name: '结果与案例', exact: true }).click();
      assert.equal(
        await work.getByRole('button', { name: '改善 2', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      await choose('选择对照实验', '');
      await work.getByRole('heading', { name: '实验结果与反例', exact: true }).waitFor();
      assert.equal(await work.getByLabel('选择对照实验').inputValue(), '', 'Explicit cancellation must remain');
      await choose('选择阅读版本', refIdentity(node('V3').nodeRef));
      await choose('选择本版实验', refIdentity(run('X4').experimentRef));
      assert.equal(await work.getByLabel('选择对照实验').inputValue(), '', 'Changed ruler has no automatic comparison');
      await choose('选择对照实验', refIdentity(run('X1').experimentRef));
      await work.locator('[data-comparison-status="unavailable"]').waitFor();
      await work.getByText('量尺不同，需按适用条件重新测量。', { exact: true }).waitFor();
      await choose('选择阅读版本', refIdentity(node('V2').nodeRef));
      await choose('选择本版实验', refIdentity(run('X3').experimentRef));
      await work.getByText(/本轮未完成有效测量/).waitFor();
      assert.equal(await work.locator('[data-comparison-status="paired"]').count(), 0);
      await choose('选择阅读版本', refIdentity(node('V4').nodeRef));
      await choose('选择本版实验', refIdentity(run('X5').experimentRef));
      await work.locator('[data-comparison-status="paired"]').waitFor();
      assert.equal(await work.getByLabel('选择对照实验').inputValue(), refIdentity(run('X4').experimentRef));
      await choose('选择本版实验', refIdentity(run('X7').experimentRef));
      await work.getByRole('button', { name: '全部 8', exact: true }).waitFor();
      assert.equal(await work.getByLabel('选择对照实验').inputValue(), refIdentity(run('X6').experimentRef));
      await work.getByRole('button', { name: '完整谱系', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '完整版本谱系' });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.exploration-node').count(), 4);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await work.locator('.exploration-next-step > summary').click();
      const sentinel = `source494-${width}: 继续查右侧场景，保留当前版本`;
      await work.getByLabel('继续探索的想法').fill(sentinel);
      await choose('选择阅读版本', refIdentity(node('V1').nodeRef));
      await work.getByText('正在阅读其它版本，这份输入仍保留原来的对象。', { exact: false }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await host.getByRole('button', { name: '展开阅读 →', exact: true }).click();
      await work.waitFor();
      assert.equal(await work.getByLabel('继续探索的想法').inputValue(), sentinel);
      assert.equal(await work.getByLabel('选择阅读版本').inputValue(), refIdentity(node('V1').nodeRef));
      const bounds = await work.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      assert(bounds.scroll <= bounds.width + 1);
      if (width === 416) {
        await page.evaluate(() => localStorage.setItem('theme', 'dark'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await host.getByRole('button', { name: '展开阅读 →', exact: true }).click();
        await work.waitFor();
        await page.screenshot({ path: `${output}/dark-416.png` });
      }
      report.checks.push({
        width,
        bounds,
        automaticComparison: true,
        manualCancellation: true,
        rulerMismatchBlocked: true,
        failedLoadVisible: true,
        caseFilterRestored: true,
        fullGraphAndEscape: true,
        draftPinnedAcrossRefresh: true,
      });
    } catch (e) {
      await page.screenshot({ path: `${output}/failed-${width}.png` });
      throw e;
    } finally {
      await context.close();
    }
  }
  assert.equal(report.errors.length, 0);
  assert.equal(report.writes.length, 0);
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
