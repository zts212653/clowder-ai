import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { refIdentity } from '@cat-cafe/shared';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import {
  accessibleExplorationNode,
  chooseExplorationRun as chooseRun,
  chooseExplorationVersion as chooseVersion,
  corruptStoredExplorationSibling,
  verifyNarrowCurrentAdoption,
  verifyNarrowExplorationEvidence,
  verifyStableExplorationTitle,
} from './f311-exploration-accessible-reading.journey.mjs';
import {
  verifyExplorationRefreshRecovery,
  verifyInvalidRecordRecovery,
  verifySameRunGuard,
} from './f311-exploration-recovery.journey.mjs';
import { startExplorationBrowserFixture } from './f311-exploration-workspace.harness.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

await import('tsx');
const evidence = process.env.F311_EVIDENCE_DIR;
const report = {
  mode: 'isolated-programs-real-owner-handlers-and-original-football-data',
  checks: [],
  screenshots: [],
};
let fixture, browser, catalog;
before(
  async () => {
    fixture = await startExplorationBrowserFixture();
    browser = await chromium.launch({ headless: true });
    if (evidence) await mkdir(evidence, { recursive: true });
    const response = await fetch(
      `${fixture.apiUrl}/api/capability-evolution/programs/${encodeURIComponent(fixture.duck.program.programId)}/exploration`,
    );
    assert.equal(response.status, 200);
    catalog = await response.json();
  },
  { timeout: 210_000 },
);
after(async () => {
  await browser?.close();
  await fixture?.close();
  assert.deepEqual(fixture?.programWrites, []);
  if (evidence) await writeFile(`${evidence}/exploration-report.json`, `${JSON.stringify(report, null, 2)}\n`);
});

async function capture(page, name) {
  if (evidence) {
    await page.screenshot({ path: `${evidence}/${name}.png` });
    report.screenshots.push(name);
  }
}
async function contained(locator) {
  const value = await locator.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
  assert(value.content <= value.width + 1, `overflow ${JSON.stringify(value)}`);
}
async function open(program = fixture.duck, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, ...options });
  await context.route('**/api/**', (route) => {
    assert(
      [fixture.webUrl, fixture.apiUrl].includes(new URL(route.request().url()).origin),
      'request escaped isolated servers',
    );
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = new URL(`/thread/${CONTRACT_THREAD_ID}`, fixture.webUrl);
  url.searchParams.set('evolutionProgram', program.program.programId);
  url.searchParams.set('evolutionView', 'judgment');
  await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === '/api/cats'), page.goto(url.href)]);
  await page.getByRole('button', { name: '探索进化', exact: true }).click();
  const work = page.getByTestId('evolution-exploration-workspace');
  await work.waitFor();
  return { page, context, work, errors };
}
const runsFor = (title) =>
  catalog.experiments.filter(
    (run) => refIdentity(run.nodeRef) === refIdentity(catalog.nodes.find((node) => node.title === title).nodeRef),
  );

test(
  'same-version runs, explicit paired scope, regressions, source traces and canvas navigation in the real F307 host',
  { timeout: 120_000 },
  async () => {
    const { page, context, work, errors } = await open();
    try {
      await verifyStableExplorationTitle(page);
      await chooseVersion(work, 'v3');
      assert.equal(await work.getByLabel('选择本版实验').locator('option:not([disabled])').count(), 3);
      for (const run of runsFor('v3')) await chooseRun(work, run);
      await verifySameRunGuard({ work, runs: runsFor('v3'), chooseRun });
      const disclosure = work.locator('details.exploration-lineage-disclosure');
      assert.equal(await disclosure.evaluate((element) => element.open), true);
      const canvas = work.getByRole('application', { name: '可平移缩放的版本画布' });
      const world = work.locator('.exploration-canvas-world');
      await work.getByRole('button', { name: '看全图', exact: true }).click();
      const fitted = await world.boundingBox();
      const frame = await canvas.boundingBox();
      assert(fitted.x >= frame.x - 1 && fitted.x + fitted.width <= frame.x + frame.width + 1);
      assert(fitted.y >= frame.y - 1 && fitted.y + fitted.height <= frame.y + frame.height + 1);
      await work.getByRole('button', { name: '定位阅读版', exact: true }).click();
      const selectedNode = await accessibleExplorationNode(
        work,
        catalog.nodes.find((node) => node.title === 'v3').summary,
      );
      assert.match(await selectedNode.textContent(), /3 轮实验/);
      assert((await selectedNode.textContent()).includes(catalog.nodes.find((node) => node.title === 'v3').summary));
      assert.equal(await work.getByLabel('当前实验条件', { exact: true }).isVisible(), true);
      await capture(page, 'exploration-default-reading');
      const transform = await world.getAttribute('style');
      await canvas.focus();
      await page.keyboard.press('ArrowLeft');
      assert.notEqual(await world.getAttribute('style'), transform);
      const bounds = await canvas.boundingBox();
      const beforeDrag = await world.getAttribute('style');
      await page.mouse.move(bounds.x + 10, bounds.y + 10);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 100, bounds.y + 10, { steps: 4 });
      await page.mouse.up();
      assert.notEqual(await world.getAttribute('style'), beforeDrag);
      await work.getByRole('button', { name: '放大谱系', exact: true }).click();
      await work.getByRole('button', { name: '定位阅读版', exact: true }).click();
      await work.getByRole('button', { name: '折叠 v3 后代', exact: true }).click();
      await work.getByText(/个节点已折叠/).waitFor();
      await capture(page, 'exploration-lineage-desktop');
      await disclosure.locator(':scope > summary').click();
      await chooseVersion(work, 'v8');
      await chooseRun(work, runsFor('v8')[0]);
      await work.getByLabel('选择对照实验').selectOption(refIdentity(runsFor('v4').at(-1).experimentRef));
      const comparison = work.getByRole('region', { name: '所选实验对照' });
      await work.locator('[data-comparison-status="scope_required"]').waitFor();
      await comparison.getByRole('button', { name: '仅比较共同的 6 个场景', exact: true }).click();
      assert.equal(await comparison.getAttribute('data-comparison-status'), 'paired');
      await comparison.getByText('已知回归', { exact: true }).waitFor();
      await comparison.getByRole('button', { name: /左侧 · 更远 ·/ }).click();
      assert.equal(await comparison.locator('.exploration-pair > .exploration-trace').count(), 2);
      await comparison
        .locator('.exploration-metric-pairs')
        .getByText('踢前躯干 XY 累计位移', { exact: true })
        .waitFor();
      await contained(work);
      await comparison.scrollIntoViewIfNeeded();
      await capture(page, 'exploration-paired-regression');
      report.checks.push(
        'v3 remains one public node with three actual runs; v4/v8 requires explicit six-input pairing; left-farther and right-wider regressions remain visible; paired traces use identical world-coordinate bounds.',
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      await capture(page, 'exploration-comparison-failure');
      throw error;
    } finally {
      await context.close();
    }
  },
);

test(
  'raw playback fails and recovers in place; source switches cannot keep the old video',
  { timeout: 120_000 },
  async () => {
    const { page, context, work, errors } = await open();
    try {
      let selected;
      for (const run of runsFor('v4').concat(runsFor('v3'))) {
        const query = new URLSearchParams({ selectedExperimentRef: JSON.stringify(run.experimentRef) });
        const body = await (
          await page.request.get(
            `${fixture.apiUrl}/api/capability-evolution/programs/${encodeURIComponent(fixture.duck.program.programId)}/exploration?${query}`,
          )
        ).json();
        const record = body.details[0]?.records?.find((record) => record.media.some((media) => media.kind === 'video'));
        if (record) {
          selected = { run, record };
          break;
        }
      }
      assert(selected, 'at least one original replay must be published');
      const title = catalog.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(selected.run.nodeRef)).title;
      await chooseVersion(work, title);
      await chooseRun(work, selected.run);
      await work.locator('.exploration-all-cases > summary').click();
      await work.locator(`[data-case-id="${selected.record.caseId}"]`).click();
      const result = work.getByRole('region', { name: '所选案例结果' });
      const videoChoice = selected.record.media.find((media) => media.kind === 'video');
      if (await result.getByRole('button', { name: videoChoice.label, exact: true }).count())
        await result.getByRole('button', { name: videoChoice.label, exact: true }).click();
      fixture.setMediaAvailable(false);
      await result.getByRole('button', { name: '在原地打开回放', exact: true }).click();
      await result.getByText('回放读取失败；当前实验与数值仍保留。', { exact: true }).waitFor();
      await result.getByRole('heading', { name: '本次实际输入与结果', exact: true }).waitFor();
      fixture.setMediaAvailable(true);
      await result.getByRole('button', { name: '重试回放', exact: true }).click();
      await result.locator('[data-playback-state="ready"]').waitFor();
      const video = result.locator('video');
      const oldSrc = await video.getAttribute('src');
      assert(await video.evaluate((v) => v.controls && v.playsInline && !v.autoplay && v.duration > 0));
      await video.evaluate((v) => v.play());
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
      await video.evaluate((v) => v.pause());
      const original = await video.elementHandle();
      await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/exploration')),
        page.evaluate(() => window.dispatchEvent(new Event('focus'))),
      ]);
      assert(
        await video.evaluate((v, old) => v === old, original),
        'same-selection refresh must preserve the video element',
      );
      assert(await video.evaluate((v) => v.currentTime > 0), 'same-selection refresh must preserve playback position');
      await capture(page, 'exploration-inline-playback');
      await verifyExplorationRefreshRecovery({
        page,
        work,
        fixture,
        result,
        video,
        original,
        record: selected.record,
        videoChoice,
        capture,
      });
      await verifyInvalidRecordRecovery({ page, work, fixture, run: selected.run, oldMediaUrl: oldSrc, capture });
      await chooseVersion(work, 'v8');
      assert.equal(await work.locator(`video[src="${oldSrc.replaceAll('"', '\\"')}"]`).count(), 0);
      assert.deepEqual(errors, []);
      report.checks.push(
        'Exact replay bytes recover; transport retains playback DOM/time; withdrawal fences the same byte endpoint; corrupt captures remove invalid observations and return 422 until explicit revalidation; selecting v8 removes old evidence.',
      );
    } catch (error) {
      await capture(page, 'exploration-playback-failure');
      throw error;
    } finally {
      fixture.setMediaAvailable(true);
      await context.close();
    }
  },
);

test(
  'narrow/dark/reduced-motion reading and immutable request recovery preserve the real Program',
  { timeout: 120_000 },
  async () => {
    const { page, context, work, errors } = await open(fixture.duck, { reducedMotion: 'reduce' });
    try {
      await chooseVersion(work, 'v8');
      await chooseRun(work, runsFor('v8')[0]);
      const input = work.getByLabel('继续探索的想法');
      const words = '补看侧向接触，保留陌生输入 beta-9 与 @opus5 原文。';
      await input.fill(words);
      await chooseVersion(work, 'v3');
      await work.getByText('正在阅读其它版本，这份输入仍保留原来的对象。', { exact: false }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: '展开阅读 →', exact: true }).click();
      await work.waitFor();
      assert.equal(await input.inputValue(), words);
      fixture.loseNextResponse();
      await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/messages' && r.request().method() === 'POST'),
        work.getByRole('button', { name: '交给猫猫继续', exact: true }).click(),
      ]);
      await work.getByRole('button', { name: '重试同一请求', exact: true }).waitFor();
      const first = fixture.writes.at(-1);
      assert.match(first.content, /"title": "v8"/);
      assert(first.content.includes(words));
      await corruptStoredExplorationSibling(page);
      await page.reload();
      await page.getByRole('button', { name: '展开阅读 →', exact: true }).click();
      await work.waitFor();
      await work.getByRole('button', { name: '重试同一请求', exact: true }).click();
      await work.getByRole('link', { name: '查看原请求与回复', exact: true }).waitFor();
      assert.equal(fixture.writes.at(-1).idempotencyKey, first.idempotencyKey);
      assert.equal(fixture.messages.size, 1);
      const reading = await page.evaluate(
        () => JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs,
      );
      assert.equal(reading[fixture.duck.program.programId].exploration.draft.binding.title, 'v8');
      for (const width of [416, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await contained(work);
        await page.getByTestId('evolution-program-surface').evaluate((el) => {
          el.scrollTop = 0;
        });
        await verifyNarrowExplorationEvidence(work, page);
        await capture(page, `exploration-narrow-${width}`);
      }
      await verifyNarrowCurrentAdoption(work, catalog);
      await page.setViewportSize({ width: 1360, height: 960 });
      const promote = page.getByRole('button', { name: '展开阅读 →', exact: true });
      // Desktop re-entry exposes this control after the media-query state update.
      await promote.click();
      await work.waitFor();
      await page.evaluate(() => {
        document.documentElement.classList.add('dark');
        document.documentElement.dataset.theme = 'dark';
      });
      await capture(page, 'exploration-dark');
      assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
      await page.getByRole('button', { name: /^← 返回(?:侧栏|详情)$/ }).click();
      await page.getByRole('region', { name: '探索进化摘要', exact: true }).waitFor();
      await page.getByRole('button', { name: '展开阅读 →', exact: true }).click();
      await work.waitFor();
      assert.equal(
        await work.getByLabel('选择阅读版本').inputValue(),
        refIdentity(catalog.nodes.find((node) => node.title === 'v3').nodeRef),
      );
      assert.equal(fixture.duck.program.sequence, 1);
      assert.deepEqual(errors, []);
      report.checks.push(
        '416/320 containment, dark tokens, reduced motion, main/rail return and refresh; v8 draft survives reading v3; a lost response retries the same canonical message id and delivery does not create a node or adoption.',
      );
    } catch (error) {
      await capture(page, 'exploration-recovery-failure');
      throw error;
    } finally {
      await context.close();
    }
  },
);

test(
  'a real isolated code invocation presents source-version-bound input and output without fabricated media',
  { timeout: 90_000 },
  async () => {
    const { page, context, work, errors } = await open(fixture.code);
    try {
      const result = work.getByRole('region', { name: '所选案例结果' });
      await result.locator('h3').getByText('未登录读取被拒绝', { exact: true }).waitFor();
      assert((await result.innerText()).includes('401'));
      assert((await result.innerText()).includes('无登录态'));
      assert.equal(await result.locator('video,img').count(), 0);
      const source = fixture.capturedCode;
      assert.match(source.nodes[0].versionRef.version, /^[a-f0-9]{64}$/);
      assert.equal(source.details[0].records[0].nodeRef.version, source.nodes[0].versionRef.version);
      await contained(work);
      await capture(page, 'exploration-code-behavior');
      assert.deepEqual(errors, []);
      report.checks.push(
        'Actual anonymous handler invocation yielded 401; exact route SHA-256, invocation window and response provenance are preserved; isolated behaviour proves no production improvement.',
      );
    } finally {
      await context.close();
    }
  },
);
