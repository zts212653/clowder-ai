import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const origin = process.env.F311_SOLUTION_ORIGIN ?? 'http://127.0.0.1:5183';
const evidence = process.env.F311_SOLUTION_EVIDENCE ?? '/tmp/cat-cafe-evidence/f311-solution';
const url = `${origin}/thread/thread-f311-workspace-contract?solutionGate=1&evolutionProgram=evolution-program%3A31103110311031103110311031103110&evolutionView=judgment`;
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { mode: 'opt-in-real-chat-f307-design-fixture', url, checks: [], errors: [], writes: [] };
try {
  for (const width of [1440, 416, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('request', (request) => {
      if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/'))
        report.writes.push({ method: request.method(), url: request.url() });
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const gate = page.getByTestId('f311-solution-lineage-gate');
      await gate.waitFor({ timeout: 60_000 });
      if (width > 1000 && (await gate.getByRole('button', { name: '在主区展开', exact: true }).count()))
        await gate.getByRole('button', { name: '在主区展开', exact: true }).click();
      await page.screenshot({ path: `${evidence}/overview-${width}.png` });
      assert.equal(await gate.locator('[data-scheme-node]').count(), 3);
      await gate.locator('[data-scheme-node="S2"]').click();
      await gate.getByRole('button', { name: /展开组成与差异/ }).click();
      await gate.getByRole('button', { name: '只看改动', exact: true }).click();
      assert.equal(await gate.locator('[data-member]').count(), 2);
      await gate.getByRole('button', { name: '本次观测', exact: true }).click();
      assert.equal(await gate.locator('[data-member]').count(), 1);
      await gate.getByRole('button', { name: '全部组成', exact: true }).click();
      await gate.getByRole('button', { name: '收起组成', exact: true }).click();
      await gate.getByRole('button', { name: /X3同版補測|X3同版补测|X3 同版补测/ }).click();
      await gate.getByText(/实际加载不符：/).waitFor();
      await gate.locator('.solution-run-context > summary').click();
      await gate.getByText('逐成员核对计划与实际 · 示例回执', { exact: true }).click();
      await gate.getByRole('cell', { name: 'H1 · 不符', exact: true }).waitFor();
      await gate.locator('[data-scheme-node="S1"]').click();
      assert.match(await gate.locator('[data-current-use]').textContent(), /沿用 S1/);
      await gate.locator('[data-scheme-node="S2"]').click();
      assert.equal(await gate.locator('[data-experiment-detail]').getAttribute('data-experiment-detail'), 'X3');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await gate.locator('[data-experiment-detail="X3"]').waitFor({ timeout: 60_000 });
      await gate.getByRole('button', { name: /X2.*成套改动/ }).click();
      await gate.getByRole('button', { name: '与 S1 的 X1 对照', exact: true }).click();
      const comparison = gate.getByRole('table', { name: 'X1 与 X2 示例比较' });
      await comparison.waitFor();
      assert.equal(await comparison.getByRole('row').count(), 7);
      await comparison.getByText('右侧更宽 · 回归', { exact: true }).waitFor();
      await comparison.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/comparison-${width}.png` });
      await gate.locator('.solution-reference > summary').click();
      await gate.getByRole('button', { name: '查看右侧更宽的真实帧', exact: true }).click();
      const source = gate.getByRole('region', { name: '原件阅读' });
      const picture = source.locator('img');
      await picture.waitFor();
      await page.waitForFunction(() => document.querySelector('.solution-source img')?.naturalWidth > 0);
      await page.screenshot({ path: `${evidence}/source-${width}.png` });
      await source.getByRole('button', { name: '← 返回所选实验', exact: true }).click();
      assert.equal(await gate.locator('[data-experiment-detail]').getAttribute('data-experiment-detail'), 'X2');
      await gate.locator('.solution-reference > summary').click();
      await page.route('**/api/design/f311-solution/source/archive-index', (route) => route.abort());
      await gate.getByRole('button', { name: '查看运行索引', exact: true }).click();
      await source.getByRole('alert').waitFor();
      await page.unroute('**/api/design/f311-solution/source/archive-index');
      await source.getByRole('button', { name: '重试原件', exact: true }).click();
      await source.getByRole('heading', { name: 'v8 真实运行索引 · 2026-09-09' }).waitFor();
      await source.getByRole('button', { name: '← 返回所选实验', exact: true }).click();
      assert.equal(await gate.locator('[data-experiment-detail]').getAttribute('data-experiment-detail'), 'X2');
      if (width === 1440) {
        await gate.getByRole('button', { name: '在主区展开', exact: true }).click();
        await gate.getByRole('button', { name: '返回侧栏', exact: true }).click();
        assert.equal(await gate.locator('[data-experiment-detail]').getAttribute('data-experiment-detail'), 'X2');
        await gate.getByRole('button', { name: '← 能力进化', exact: true }).click();
        const home = page.getByTestId('capability-evolution-workspace');
        await home
          .getByTestId('capability-evolution-program-evolution-program:31103110311031103110311031103110')
          .click();
        await page.screenshot({ path: `${evidence}/native-entry-1440.png` });
        await home.getByRole('button', { name: '展开阅读 →', exact: true }).click();
        await gate.locator('[data-experiment-detail="X2"]').waitFor();
        await gate.getByRole('button', { name: '收起对照', exact: true }).waitFor();
      }
      await gate.locator('[data-scheme-node="S1"]').click();
      await gate.locator('.solution-rejudgment > summary').click();
      await gate.getByText(/缺少越线观测，无法判断有效进球/).waitFor();
      await gate.locator('[data-scheme-node="S3"]').click();
      await gate.getByText('尚未运行；没有实际加载、成绩或成本回执。', { exact: true }).waitFor();
      assert.equal(await gate.locator('[data-scheme-node]').count(), 3);
      await gate.getByRole('button', { name: '夹具控制', exact: true }).click();
      const scenario = gate.getByLabel('设计稿场景');
      await scenario.selectOption('unknown');
      await gate.locator('[data-current-use]').getByText('当前沿用未知', { exact: true }).waitFor();
      await scenario.selectOption('failed');
      await gate.getByRole('heading', { name: '方案读取失败' }).waitFor();
      await gate.getByRole('button', { name: '重试读取' }).click();
      await gate.locator('[data-experiment-detail="X4"]').waitFor();
      await scenario.selectOption('empty');
      await gate.getByRole('heading', { name: '尚无可读方案' }).waitFor();
      await scenario.selectOption('full');
      const geometry = await gate.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      assert(geometry.scrollWidth <= geometry.width + 1, `overflow at ${width}: ${JSON.stringify(geometry)}`);
      if (width === 416) {
        await page.evaluate(() => localStorage.setItem('theme', 'dark'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await gate.waitFor();
        await page.screenshot({ path: `${evidence}/dark-416.png` });
        await page.evaluate(() => localStorage.setItem('f311-solution-design-reading-v1', '{broken'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await gate.getByText('上次阅读位置无法恢复；已回到方案总览。', { exact: true }).waitFor();
      }
      report.checks.push({
        width,
        branches: 3,
        sameSchemeRuns: 'X2/X3',
        refreshRestores: 'X3',
        oldReadingKeepsUse: true,
        comparisonIncludesRegression: true,
        originalFrame: true,
        rulerRejudgment: 'old retained; new unknown',
        failures: ['current unknown', 'read retry', 'empty', 'source abort/retry'],
        geometry,
      });
    } catch (error) {
      await page.screenshot({ path: `${evidence}/failure-${width}.png` });
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, []);
  assert(
    report.writes.every(
      (entry) => new URL(entry.url).pathname === '/api/threads/thread-f311-workspace-contract/read/latest',
    ),
    'only the native shell read acknowledgement may attempt a write; fixture rejects it',
  );
  report.programWrites = report.writes.filter((entry) =>
    new URL(entry.url).pathname.startsWith('/api/capability-evolution/'),
  );
  assert.deepEqual(report.programWrites, []);
} finally {
  await browser.close();
  await writeFile(`${evidence}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
