import assert from 'node:assert/strict';
import { refIdentity } from '@cat-cafe/shared';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import {
  chooseExplorationComparison,
  chooseExplorationRun,
  chooseExplorationVersion,
} from './f311-exploration-accessible-reading.journey.mjs';
import { waitForResponsiveWorkspaceLayout } from './f311-responsive-workspace-layout.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

/** Isolated owner-bound Program, original public archive bytes; not the real 352afab6 binding. */
export async function verifyV2ExplorationReading({ fixture, browser, catalog, capture }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/api/**', (route) => {
    assert(
      [fixture.webUrl, fixture.apiUrl].includes(new URL(route.request().url()).origin),
      'request escaped isolated servers',
    );
    return route.continue();
  });
  const work = page.getByTestId('evolution-exploration-workspace');
  try {
    await page.goto(`${fixture.apiUrl}/api/session`);
    await page.goto(`${fixture.webUrl}/thread/${CONTRACT_THREAD_ID}?shell=v2`);
    await (await openWorkspaceTools(page)).getByTestId('workspace-launcher-capability-evolution').click();
    const home = page.getByTestId('capability-evolution-workspace');
    await home.getByTestId(`capability-evolution-program-${fixture.duck.program.programId}`).click();
    const detail = home.getByTestId('capability-evolution-program-detail');
    await detail.getByRole('button', { name: '探索进化', exact: true }).click();
    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    await work.waitFor();
    assert.equal(await work.getAttribute('data-exploration-presentation'), 'v2');
    assert.equal(await work.locator('.exploration-version-nav').getAttribute('data-map-open'), 'true');
    assert.equal(await work.getByRole('button', { name: /^阅读 / }).count(), catalog.nodes.length);
    const adoption = work.getByRole('region', { name: '生效与阅读状态' });
    assert((await adoption.innerText()).includes('当前采用：'));
    assert((await adoption.innerText()).includes('来源当前版本：'));
    await capture(page, 's3-v2-settings-map');
    await work.getByRole('button', { name: '完整谱系', exact: true }).click();
    const graph = page.getByRole('dialog', { name: '完整版本谱系', exact: true });
    assert.equal(await graph.getByRole('button', { name: /^阅读 / }).count(), catalog.nodes.length);
    await graph.getByRole('button', { name: '看全图', exact: true }).click();
    for (const label of ['本项目版本', '公开归档 · 已登记派生', '公开归档 · 父版未登记']) {
      await graph.getByRole('region', { name: `谱系分组：${label}`, exact: true }).waitFor();
    }
    assert.equal(await graph.getByRole('region', { name: /^谱系分组：/ }).count(), 3);
    const beside = await graph.locator('[data-label-visible="true"]').evaluateAll((nodes) =>
      nodes.every((node) => {
        const point = node.getBoundingClientRect();
        const label = node.querySelector('.exploration-node-title').getBoundingClientRect();
        return Math.abs(label.y + label.height / 2 - (point.y + point.height / 2)) <= 10;
      }),
    );
    assert.ok(beside, 'fit labels belong beside their own points, not between vertically adjacent versions');
    const lastLabel = graph.getByRole('button', { name: '阅读 v8', exact: true }).locator('.exploration-node-title');
    const labelBox = await lastLabel.boundingBox();
    const canvasBox = await graph.getByRole('application', { name: '可平移缩放的版本画布' }).boundingBox();
    assert.ok(labelBox && canvasBox && labelBox.y + labelBox.height <= canvasBox.y + canvasBox.height + 1);
    await capture(page, 's3-v2-full-lineage');
    await graph.getByRole('button', { name: '返回比较', exact: true }).click();
    const runsFor = (title) =>
      catalog.experiments.filter(
        (run) => refIdentity(run.nodeRef) === refIdentity(catalog.nodes.find((node) => node.title === title).nodeRef),
      );
    const currentRun = runsFor('v8')[0];
    const baselineRun = runsFor('v4').at(-1);
    const query = new URLSearchParams({
      selectedExperimentRef: JSON.stringify(currentRun.experimentRef),
      comparisonExperimentRef: JSON.stringify(baselineRun.experimentRef),
    });
    const response = await page.request.get(
      `${fixture.apiUrl}/api/capability-evolution/programs/${encodeURIComponent(fixture.duck.program.programId)}/exploration?${query}`,
    );
    assert.equal(response.status(), 200);
    const publication = await response.json();
    assert.deepEqual(publication.objectRef, fixture.duck.program.objectRef);
    const right = publication.details.find(
      (item) => refIdentity(item.experimentRef) === refIdentity(currentRun.experimentRef),
    );
    const left = publication.details.find(
      (item) => refIdentity(item.experimentRef) === refIdentity(baselineRun.experimentRef),
    );
    assert.equal(right.status, 'resolved');
    assert.equal(left.status, 'resolved');
    const failing = right.records.find((record) => record.result.status === 'violated');
    assert(failing, 'real archive must declare a bounded counterexample for this selected run');
    await chooseExplorationVersion(work, 'v8');
    await chooseExplorationRun(work, currentRun);
    await chooseExplorationComparison(work, refIdentity(baselineRun.experimentRef));
    const comparison = work.getByRole('region', { name: '所选实验对照' });
    await work.locator('[data-comparison-status="scope_required"]').waitFor();
    await comparison.getByRole('button', { name: '仅比较共同的 6 个场景', exact: true }).click();
    await comparison.getByRole('button', { name: /^改善 [1-9]/ }).click();
    const counterexample = comparison.getByRole('region', { name: '本次判据未通过的记录' });
    await counterexample
      .getByRole('heading', { name: `本次判据未通过的记录 · ${failing.label}`, exact: true })
      .waitFor();
    assert.equal(
      await work.getByLabel('当前实验条件', { exact: true }).isVisible(),
      true,
      'conditions follow visible evidence in v2',
    );
    assert((await adoption.innerText()).includes('正在读：v8'));
    await counterexample.scrollIntoViewIfNeeded();
    await capture(page, 's3-v2-counterexample');
    await comparison.getByRole('button', { name: /^全部 / }).click();
    const replay = right.records
      .map((record) => ({
        right: record,
        left: left.records.find((before) => refIdentity(before.inputRef) === refIdentity(record.inputRef)),
      }))
      .find(
        (pair) =>
          pair.left?.media.some((media) => media.kind === 'video') &&
          pair.right.media.some((media) => media.kind === 'video'),
      );
    assert(replay, 'a paired original video must exist on each side');
    const label = replay.right.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await comparison
      .locator('.exploration-case-nav')
      .getByRole('button', { name: new RegExp(`^${label}\\s`) })
      .click();
    const focus = comparison.locator('.exploration-pair-focus');
    const outcomes = focus.locator('.exploration-outcome');
    for (const [index, record] of [replay.left, replay.right].entries()) {
      const video = record.media.find((media) => media.kind === 'video');
      const choice = outcomes.nth(index).getByRole('button', { name: video.label, exact: true });
      if (await choice.count()) await choice.click();
    }
    await focus.getByRole('button', { name: '两段同步播放', exact: true }).click();
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('.exploration-pair-focus video')];
      return videos.length === 2 && videos.every((video) => !video.paused && video.currentTime > 0.1);
    });
    const sources = await focus.locator('video').evaluateAll((videos) => videos.map((video) => video.src));
    for (const [index, record] of [replay.left, replay.right].entries()) {
      const url = new URL(sources[index]);
      assert.deepEqual(JSON.parse(url.searchParams.get('recordRef')), record.recordRef);
      assert.deepEqual(JSON.parse(url.searchParams.get('experimentRef')), record.experimentRef);
    }
    await focus
      .locator('video')
      .first()
      .evaluate((video) => {
        video.currentTime = 2;
      });
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('.exploration-pair-focus video')];
      return (
        videos.every((video) => !video.seeking && video.currentTime >= 2) &&
        Math.abs(videos[0].currentTime - videos[1].currentTime) < 0.25
      );
    });
    await focus.getByRole('button', { name: '暂停联播', exact: true }).click();
    assert(await focus.locator('video').evaluateAll((videos) => videos.every((video) => video.paused)));
    await focus.scrollIntoViewIfNeeded();
    await capture(page, 's3-v2-linked-originals');
    const main = page.locator('[data-testid="evolution-program-surface"]:visible');
    for (const width of [416, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await waitForResponsiveWorkspaceLayout(page, main, width);
      assert.equal(await work.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
      await work.getByRole('button', { name: '收起地图', exact: true }).click();
      await focus.scrollIntoViewIfNeeded();
      await capture(page, `s3-v2-originals-${width}`);
      await work.getByRole('button', { name: '展开地图', exact: true }).click();
    }
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    // Reading is durable; main-area attention is transient. Re-enter explicitly after refresh.
    const returnedDetail = page.locator('[data-testid="capability-evolution-program-detail"]:visible');
    await returnedDetail.getByRole('region', { name: '探索进化摘要', exact: true }).waitFor();
    await returnedDetail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    await work.waitFor();
    await capture(page, 's3-v2-dark-restored');
    assert.equal(await work.getByLabel('选择本版实验').inputValue(), refIdentity(currentRun.experimentRef));
    await main.getByRole('button', { name: /^← 返回(?:侧栏|详情)$/ }).click();
    await returnedDetail.getByRole('region', { name: '探索进化摘要', exact: true }).waitFor();
    await returnedDetail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    await work.waitFor();
    assert.equal(await work.getByLabel('选择本版实验').inputValue(), refIdentity(currentRun.experimentRef));
    assert.equal(await work.getByLabel('选择对照实验').inputValue(), refIdentity(baselineRun.experimentRef));
    assert.equal(fixture.duck.program.sequence, 1);
    assert.deepEqual(errors, []);
  } catch (error) {
    await capture(page, 's3-v2-failure');
    throw error;
  } finally {
    await context.close();
  }
}
