import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const origin = process.env.F311_DUCK_DEMO_ORIGIN ?? 'http://127.0.0.1:5187';
const evidence = process.env.F311_DUCK_DEMO_EVIDENCE ?? '/tmp/cat-cafe-evidence/f311-duck-demo';
const url = `${origin}/thread/thread-f311-workspace-contract?solutionGate=1&duckDemo=1&evolutionProgram=evolution-program%3A31103110311031103110311031103110&evolutionView=judgment`;
const report = { url, checks: [], pageErrors: [], programWrites: [], otherWrites: [] };
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 416, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (e) => report.pageErrors.push({ width, message: e.message }));
    page.on('request', (req) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return;
      const path = new URL(req.url()).pathname;
      if (path.includes('capability-evolution')) report.programWrites.push(path);
      else if (path.startsWith('/api/')) report.otherWrites.push(path);
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const demo = page.getByTestId('f311-duck-evolution-demo');
      await demo.waitFor({ timeout: 90000 });
      if (width === 1440 && (await demo.getByRole('button', { name: '在主区展开', exact: true }).count()))
        await demo.getByRole('button', { name: '在主区展开', exact: true }).click();
      await demo.getByRole('heading', { name: '鸭到位了，球却走了', exact: true }).waitFor();
      assert.equal(await demo.locator('[data-version]').count(), 4);
      await page.screenshot({ path: `${evidence}/start-${width}.png` });
      await demo.getByText('看“球走了”的动作示意', { exact: true }).click();
      await demo.getByRole('button', { name: 'V2 · 持续修正', exact: true }).click();
      await demo.getByLabel('动作示意进度').fill('86');
      assert.equal(await demo.getByLabel('动作示意进度').inputValue(), '86');
      await demo.getByRole('button', { name: '2 选择改法', exact: true }).click();
      await demo.getByRole('cell', { name: '右侧更宽 · 退步', exact: true }).waitFor();
      await demo.getByText('展开评估方案：rubric、benchmark 和证据怎么接？', { exact: true }).click();
      await demo.getByText(/R1：26 秒内/).waitFor();
      await demo.getByRole('button', { name: '3 核对加载', exact: true }).click();
      await demo.getByText(/计划 H2，实际示例回执 H1/).waitFor();
      await demo.getByRole('button', { name: '4 换眼睛尺子', exact: true }).click();
      await demo.getByRole('region', { name: '这一版用什么看和判' }).getByText('EV2 / R2', { exact: true }).waitFor();
      await demo.locator('[data-version="V1"]').click();
      await demo.getByText('后来用 R2 重判 X1，会发生什么？', { exact: true }).click();
      await demo.getByText(/J2 \/ R2：缺越线观测，无法重判/).waitFor();
      await demo.getByRole('button', { name: '5 合并重测', exact: true }).click();
      await demo.getByText('展开组成：具体改了哪几样？', { exact: true }).click();
      await demo.getByText(/来源边：H2\/C2 ← V2；O2\/R2 ← V3/).waitFor();
      await demo.getByRole('region', { name: '本次模拟实验' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/comparison-${width}.png` });
      await demo.getByRole('button', { name: '6 新场景验证', exact: true }).click();
      assert.equal(await demo.getByRole('table', { name: '逐场景模拟比较' }).getByRole('row').count(), 9);
      await demo.getByRole('button', { name: '7 有限采用', exact: true }).click();
      const adoption = demo.getByRole('region', { name: '模拟采用与实际使用' });
      await adoption.getByText(/只让左侧训练 consumer 试用 V4/).waitFor();
      await demo.locator('[data-version="V1"]').click();
      await adoption.getByText(/右侧 consumer 匹配 V3/).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await adoption.waitFor({ timeout: 60000 });
      await demo.locator('[data-version="V1"][aria-pressed="true"]').waitFor();
      await demo.locator('[data-version="V4"]').click();
      await demo.getByRole('button', { name: 'X7 · D2', exact: true }).click();
      await adoption.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/adoption-${width}.png` });
      if (width === 1440) {
        await demo.getByRole('button', { name: '1 看见不足', exact: true }).click();
        await demo.getByRole('button', { name: '播放讲解', exact: true }).click();
        await page.waitForTimeout(12500);
        await demo.getByRole('button', { name: '暂停讲解', exact: true }).click();
        const step = await demo.locator('.duck-chapters [aria-pressed="true"]').textContent();
        assert.equal(step, '2 选择改法');
        await page.waitForTimeout(12500);
        assert.equal(await demo.locator('.duck-chapters [aria-pressed="true"]').textContent(), step);
        await demo.getByRole('button', { name: '下一幕', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
        await demo.getByRole('button', { name: '3 核对加载', exact: true, pressed: true }).waitFor();
      }
      if (width === 416) {
        await demo.getByRole('button', { name: '隐藏讲解控制', exact: true }).click();
        assert.equal(await demo.getByRole('region', { name: '模拟故事讲解控制' }).count(), 0);
        await page.evaluate(() => localStorage.setItem('theme', 'dark'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await demo.waitFor();
        await page.screenshot({ path: `${evidence}/dark-${width}.png` });
        await page.evaluate(() => localStorage.setItem('f311-duck-simulation-reading-v1', '{bad'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await demo.getByText('上次阅读位置无法恢复，已回到第一幕。', { exact: true }).waitFor();
      }
      const geometry = await demo.evaluate((el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
      assert(geometry.scrollWidth <= geometry.width + 1, `overflow: ${JSON.stringify(geometry)}`);
      report.checks.push({
        width,
        geometry,
        allChapters: true,
        refreshRestored: true,
        adoptionUnaffectedByReading: true,
      });
    } catch (error) {
      await page.screenshot({ path: `${evidence}/failed-${width}.png` });
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.equal(report.pageErrors.length, 0);
  assert.equal(report.programWrites.length, 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
