import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { evolutionExplorationReviewV1Schema } from '../../../shared/dist/index.js';

const origin = 'http://127.0.0.1:5188';
const program = 'evolution-program:31103110311031103110311031103110';
const url = `${origin}/thread/thread-f311-workspace-contract?evolutionProgram=${encodeURIComponent(program)}&evolutionView=judgment&mockExploration=1`;
const output = '/tmp/cat-cafe-evidence/f311-semantic-lineage';
await mkdir(output, { recursive: true });
const report = { url, checks: [], errors: [], writes: [] };
const browser = await chromium.launch({ headless: true });
async function enter(page) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const host = page.getByTestId('mock-exploration-host');
  await host.getByRole('button', { name: '探索进化', exact: true }).click({ timeout: 60000 });
  const expand = host.getByRole('button', { name: '展开阅读 →', exact: true });
  if (await expand.count()) await expand.click();
  const work = page.getByTestId('evolution-exploration-workspace');
  await work.waitFor();
  return work;
}
function observe(page) {
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/capability-evolution/')) report.writes.push(r.url());
  });
}
try {
  for (const width of process.argv.includes('--dense-only') ? [] : [1440, 416, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    observe(page);
    try {
      const work = await enter(page);
      const map = work.locator('.exploration-embedded-map');
      const selected = await work.getByLabel('选择阅读版本').inputValue();
      if (width < 900) {
        assert.equal(await map.isVisible(), false, 'Small screens start with result reading');
        await work.getByRole('button', { name: '展开地图', exact: true }).click();
        assert.equal(
          await work.getByLabel('谱系排列').inputValue(),
          'vertical',
          'First narrow expansion offers a vertical reading',
        );
      }
      assert.equal(await map.isVisible(), true);
      await page.screenshot({ path: `${output}/initial-map-${width}.png` });
      if (width === 1440) {
        assert.equal(
          await work.getByLabel('选择阅读版本').isVisible(),
          false,
          'Desktop uses the graph, not a duplicate version dropdown',
        );
        const rows = await map
          .locator('.exploration-canvas-tools > *')
          .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
        assert(Math.max(...rows) - Math.min(...rows) < 12, 'Desktop graph controls share one toolbar row');
      }
      await work.getByLabel('谱系排列').selectOption('vertical');
      await map.getByRole('button', { name: '看全图', exact: true }).click();
      assert.equal(await work.getByLabel('选择阅读版本').inputValue(), selected);
      const positions = await map
        .locator('.exploration-node-wrap')
        .evaluateAll((els) => els.map((el) => ({ x: el.offsetLeft, y: el.offsetTop })));
      assert(positions[1].y > positions[0].y, 'Chosen vertical reading must have vertical ancestry');
      assert.equal(await map.locator('.exploration-edges path').count(), 4, 'Merge must retain both parents');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('mock-exploration-host').getByRole('button', { name: '展开阅读 →', exact: true }).click();
      await work.waitFor();
      assert.equal(await work.getByLabel('谱系排列').inputValue(), 'vertical');
      assert.equal(await map.isVisible(), true, 'Expanded map survives reload');
      await work.getByLabel('谱系排列').selectOption('map');
      await map.getByRole('button', { name: '看全图', exact: true }).click();
      const fitZoom = Number.parseFloat(await map.getByLabel('谱系缩放').textContent());
      for (
        let i = 0;
        i < 10 && (await map.locator('.exploration-lineage').getAttribute('data-density')) !== 'points';
        i++
      ) {
        await map.getByRole('button', { name: '缩小谱系', exact: true }).click();
      }
      assert.equal(await map.locator('.exploration-lineage').getAttribute('data-density'), 'points');
      for (let i = 0; i < 20 && !(await map.getByRole('button', { name: '缩小谱系', exact: true }).isDisabled()); i++) {
        await map.getByRole('button', { name: '缩小谱系', exact: true }).click();
      }
      assert(Number.parseFloat(await map.getByLabel('谱系缩放').textContent()) >= fitZoom * 0.79);
      assert.equal(
        await map.locator('.exploration-node-wrap[data-label-visible="true"]').count(),
        4,
        'Sparse overview must name all four versions',
      );
      await page.screenshot({ path: `${output}/points-${width}.png` });
      await map.getByRole('button', { name: '定位阅读版', exact: true }).click();
      await map.getByRole('button', { name: '放大谱系', exact: true }).click();
      await map.getByRole('button', { name: '放大谱系', exact: true }).click();
      assert.equal(await map.locator('.exploration-lineage').getAttribute('data-density'), 'detail');
      const typeSize = await map
        .locator('.exploration-node-summary')
        .first()
        .evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { ratio: rect.width / el.offsetWidth, font: getComputedStyle(el).fontSize };
        });
      assert(Math.abs(typeSize.ratio - 1) < 0.03, 'Node text must remain at screen size');
      await map.getByRole('button', { name: '定位阅读版', exact: true }).click();
      await page.screenshot({ path: `${output}/detail-${width}.png` });
      const canvas = map.locator('.exploration-canvas');
      const bounds = await canvas.boundingBox();
      const world = map.locator('.exploration-canvas-world');
      const initial = await world.getAttribute('style');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 20);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + 45, { steps: 4 });
      await page.mouse.up();
      assert.notEqual(await world.getAttribute('style'), initial, 'Dragging actually moves the canvas');
      await work.getByRole('button', { name: '完整谱系', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '完整版本谱系' });
      await dialog.waitFor();
      assert.equal(await page.locator('.exploration-canvas').count(), 1, 'Only one camera owns the reading viewport');
      await dialog.getByRole('button', { name: '看全图', exact: true }).click();
      await page.screenshot({ path: `${output}/full-${width}.png` });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await map.getByRole('button', { name: '看全图', exact: true }).click();
      const bodyBounds = await work.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      assert(bodyBounds.scroll <= bodyBounds.width + 1);
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('mock-exploration-host').getByRole('button', { name: '展开阅读 →', exact: true }).click();
      await work.waitFor();
      await page.screenshot({ path: `${output}/dark-${width}.png` });
      report.checks.push({
        width,
        bodyBounds,
        typeSize,
        verticalPreserved: true,
        mergeParents: true,
        drag: true,
        oneCamera: true,
      });
    } catch (e) {
      await page.screenshot({ path: `${output}/failed-${width}.png` });
      throw e;
    } finally {
      await context.close();
    }
  }
  // Synthetic 64-node branching/merge catalog through the existing read endpoint, never Program data.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  observe(page);
  try {
    const template = await (
      await fetch(`${origin}/api/capability-evolution/programs/${encodeURIComponent(program)}/exploration`)
    ).json();
    await page.route(/\/exploration(?:\?|$)/, async (route) => {
      const data = structuredClone(template);
      const base = data.nodes[0];
      const ref = (i) => ({ ...base.nodeRef, ownerStateRef: `synthetic-lineage:${i}` });
      data.nodes = Array.from({ length: 64 }, (_, i) => ({
        ...base,
        nodeRef: ref(i),
        title: `模拟压力 ${i}`,
        summary: '合成关系样例；无测量成绩',
        changes: [],
        parentEdges:
          i === 0
            ? []
            : [...new Set([Math.floor((i - 1) / 2), ...(i === 63 ? [61] : [])])].map((parent) => ({
                parentNodeRef: ref(parent),
                sourceRef: base.sourceRef,
              })),
      }));
      data.experiments = [];
      data.details = [];
      evolutionExplorationReviewV1Schema.parse(data);
      await route.fulfill({ json: data });
    });
    const work = await enter(page);
    await work.getByRole('button', { name: '完整谱系', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '完整版本谱系' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '看全图', exact: true }).click();
    assert.equal(await dialog.locator('.exploration-node').count(), 64);
    assert.equal(await dialog.locator('.exploration-lineage').getAttribute('data-density'), 'points');
    assert.equal(await dialog.locator('.exploration-edges path').count(), 64);
    await page.screenshot({ path: `${output}/dense-64.png` });
    await dialog.getByRole('button', { name: '定位阅读版', exact: true }).click();
    assert.notEqual(await dialog.locator('.exploration-lineage').getAttribute('data-density'), 'points');
    report.checks.push({ syntheticNodes: 64, visibleEdges: 64, noScoresInvented: true, overviewAndLocate: true });
  } catch (error) {
    await page.screenshot({ path: `${output}/dense-failure.png` });
    throw error;
  } finally {
    await context.close();
  }
  assert.equal(report.errors.length, 0);
  assert.equal(report.writes.length, 0);
} finally {
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
