import assert from 'node:assert/strict';

export const MICRODUCK_BASELINE_VERSION = '183f99a40bd7308da3e848de961ed32bb02624a5';

export function createMicroduckProgramFixture(programFixture) {
  const projection = programFixture();
  projection.program.displayName = 'Microduck 行走控制（隔离 owner 契约）';
  projection.program.objectRef = {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: 'simulator:walking',
    version: MICRODUCK_BASELINE_VERSION,
  };
  projection.program.currentAssetVersionRefs = [];
  projection.cycles[0].lineageRefIds = [];
  projection.observation = { status: 'insufficient', connectedEyes: [], gaps: [] };
  projection.lineage = { cycles: [{ cycle: 1, changes: [] }] };
  return projection;
}

async function playVideo(page, scope, label) {
  const video = scope.locator(`video[aria-label="${label}"]`);
  await video.waitFor();
  await video.evaluate((element) => element.play());
  await page.waitForFunction(
    (target) => {
      const element = document.querySelector(`video[aria-label="${target}"]`);
      return element instanceof HTMLVideoElement && element.videoWidth > 0 && element.currentTime > 0;
    },
    label,
    { timeout: 15_000 },
  );
  return video.evaluate((element) => {
    element.pause();
    return {
      currentTime: element.currentTime,
      duration: element.duration,
      videoWidth: element.videoWidth,
      videoHeight: element.videoHeight,
    };
  });
}

export async function verifyMicroduckPreparationReading({
  page,
  base,
  threadId,
  programId,
  navigateShell,
  ensureWorkspaceOpen,
  capture,
  assertContained,
  programWrites,
  publishLatestPreparation,
  setPreparationMediaAvailable,
}) {
  const projectionResponse = await page.request.get(
    new URL(`/api/capability-evolution/programs/${encodeURIComponent(programId)}`, base).href,
  );
  assert.equal(projectionResponse.status(), 200);
  const initialSequence = (await projectionResponse.json()).program.sequence;
  await navigateShell(page, new URL(`/thread/${threadId}`, base).href);
  await ensureWorkspaceOpen(page);
  await page.getByText('能力进化', { exact: true }).first().click();
  const workspace = page.getByTestId('capability-evolution-workspace');
  await workspace.getByTestId(`capability-evolution-program-${programId}`).click();
  const detail = page.getByTestId('capability-evolution-program-detail');
  const detailJourney = detail.getByRole('navigation', { name: '能力进化旅程' });
  await detailJourney.getByRole('button', { name: '探索进化', exact: true }).click();
  const candidateEntry = detail.getByRole('button', { name: '回读准备材料', exact: true });
  await candidateEntry.waitFor();
  await capture(page, 'microduck-public-experiment-entry');
  await candidateEntry.click();
  await detail.evaluate((element) => {
    window.__f311PreparationDetail = element;
  });
  const initialV3 = detail.locator('article.evolution-material').filter({ hasText: 'v3 · 前进弧线路径' });
  await initialV3.getByText('运行中', { exact: true }).waitFor();
  await initialV3.getByText('v3 公开运行仍在进行；尚无完成结果。', { exact: true }).waitFor();
  assert.equal(
    await detail.getByRole('heading', { name: 'v3 时间补充 · 同一控制器的 26 秒条件', exact: true }).count(),
    0,
  );
  assert.equal(
    await detail.getByRole('heading', { name: 'v4 · 缩短弧线，右侧踢中、左侧踢空', exact: true }).count(),
    0,
  );
  assert.equal(await detail.locator('time[datetime="2026-09-07T19:20:00.000Z"]').count(), 7);
  publishLatestPreparation();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const newMaterial = detail.getByRole('heading', {
    name: 'v3 时间补充 · 同一控制器的 26 秒条件',
    exact: true,
  });
  await newMaterial.waitFor();
  await detail.getByRole('heading', { name: 'v4 · 缩短弧线，右侧踢中、左侧踢空', exact: true }).waitFor();
  assert.equal(
    await detail.evaluate((element) => element === window.__f311PreparationDetail),
    true,
    'owner publication refreshes in the mounted Program instead of replacing the page',
  );
  await detail
    .locator('article.evolution-material')
    .filter({ hasText: 'v3 时间补充 · 同一控制器的 26 秒条件' })
    .getByText('结果已完成', { exact: true })
    .waitFor();
  await detail.locator('time[datetime="2026-09-07T22:39:35.000Z"]').first().waitFor();
  await capture(page, 'microduck-owner-publication-updated');

  await detail.getByRole('button', { name: '展开阅读 →', exact: true }).click();
  const program = page.getByTestId('evolution-program-surface');
  await page.locator('[data-presentation="main-area-attention"]').waitFor();
  const journey = program.getByRole('navigation', { name: '能力进化旅程' });
  await program.getByRole('tab', { name: '更改历史', exact: true }).click();
  const historyEntry = program.getByRole('button', { name: '查看已发布的公开实验与回放', exact: true });
  await historyEntry.waitFor();
  await capture(page, 'microduck-history-public-experiment-entry');
  await historyEntry.click();
  const publicRuns = program.getByText('40 次公开运行与候选筛选', { exact: true });
  await publicRuns.waitFor();
  await program.getByText('带球场景的可复用起点', { exact: true }).waitFor();
  const footballArchive = program.getByRole('heading', { name: '足球公开归档（新项目尚未建制）', exact: true });
  await footballArchive.waitFor();
  for (const title of [
    '足球环境、采集与录像总览',
    '起步、侧移与转向诊断',
    'v0 · 原地踢球基线',
    'v1 · 走近命令尚未起步',
    'v2 · 直线远球恢复',
    'v3 · 前进弧线路径',
    'v3 时间补充 · 同一控制器的 26 秒条件',
    'v4 · 缩短弧线，右侧踢中、左侧踢空',
  ])
    await program.getByRole('heading', { name: title, exact: true }).waitFor();
  await program.getByText(/44 场景、38,644 条状态、20 段真实录像/u).waitFor();
  await program.getByText(/它不是第五个控制器版本，也不改判 v3 原 20 秒未完成/u).waitFor();
  assert.equal(
    await program.getByRole('button', { name: 'v3 · 前进弧线路径', exact: true }).count(),
    0,
    'football archive versions are visible preparation materials, not walking candidates',
  );
  const briefingSource = program.locator('details.evolution-source').filter({ hasText: '十段回放说明' });
  await briefingSource.locator('summary').click();
  assert.match(
    await briefingSource.getByRole('link', { name: '打开来源', exact: true }).getAttribute('href'),
    /a9b28fa76235f5635bd9b2fd3a974a78afafc732\/docs\/videos\/f311-microduck-roadshow\/briefing\/README\.md$/u,
  );
  const playbackButtons = program.getByRole('button', { name: /^在页面内播放：/u });
  assert.equal(await playbackButtons.count(), 14, 'only the fourteen selected publication videos are exposed');
  assert.equal(await program.locator('video').count(), 0, 'video bytes stay lazy before a user asks to play');
  const v4 = program.locator('article.evolution-material').filter({
    hasText: 'v4 · 缩短弧线，右侧踢中、左侧踢空',
  });
  await v4.getByText(/右偏远球 18\.905 秒触球/u).waitFor();
  await v4.getByText(/左偏远球 18\.9 秒踢腿但全程无接触/u).waitFor();
  await v4.getByText(/双侧改善假设不满足；不采用/u).waitFor();
  const v4ReplayLabels = ['v4 · 左偏远球踢空回放', 'v4 · 右偏远球踢中回放', 'v4 · 左直线回放', 'v4 · 右直线回放'];
  for (const label of v4ReplayLabels)
    assert.equal(await v4.getByRole('button', { name: `在页面内播放：${label}`, exact: true }).count(), 1);
  const replayLabel = v4ReplayLabels[0];
  setPreparationMediaAvailable(false);
  await v4.getByRole('button', { name: `在页面内播放：${replayLabel}`, exact: true }).click();
  await v4.getByText('回放加载失败；材料说明仍可阅读。', { exact: true }).waitFor();
  await capture(page, 'microduck-inline-replay-failure');
  setPreparationMediaAvailable(true);
  await v4.getByRole('button', { name: `重试：${replayLabel}`, exact: true }).click();
  const playback = await playVideo(page, v4, replayLabel);
  assert(playback.currentTime > 0 && playback.videoWidth > 0 && playback.videoHeight > 0);
  for (const label of v4ReplayLabels.slice(1)) {
    await v4.getByRole('button', { name: `在页面内播放：${label}`, exact: true }).click();
    const measurement = await playVideo(page, v4, label);
    assert.equal(measurement.duration, 20.1);
  }
  await capture(page, 'microduck-inline-replay-playing');
  assert.equal(await program.getByText('尚未接入可核验的反馈。', { exact: true }).count(), 1);
  await footballArchive.scrollIntoViewIfNeeded();
  await assertContained(program);
  await capture(page, 'microduck-owner-preparation-desktop');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth === 320,
  );
  await program
    .getByRole('heading', { name: 'v4 · 缩短弧线，右侧踢中、左侧踢空', exact: true })
    .scrollIntoViewIfNeeded();
  await assertContained(program);
  await capture(page, 'microduck-football-preparation-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  const expandAfterResize = program.getByRole('button', { name: '展开阅读 →', exact: true });
  // Desktop re-entry exposes this control after the media-query state update.
  await expandAfterResize.click();
  await page.locator('[data-presentation="main-area-attention"]').waitFor();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth ?? 0) >= 1000,
  );

  await journey.getByRole('button', { name: '探索进化', exact: true }).click();
  await program.getByText('准备阶段的公开候选与取舍', { exact: true }).click();
  const candidate = program.locator('button.evolution-link').filter({ hasText: 'action_scale = 1.10' });
  await candidate.waitFor();
  assert.equal(await candidate.count(), 1);
  const candidateSummary = program.getByRole('paragraph').filter({
    hasText: '公开比较达到预注册门槛，公开预选进入 holdout；密封 holdout 尚未进行，不是正式 winner 或采用。',
  });
  await candidateSummary.waitFor();
  assert.equal(await candidateSummary.count(), 1);
  await candidate.click();
  const selectedHeading = program.getByRole('heading', {
    name: '正在阅读 action_scale = 1.10',
    exact: true,
  });
  await selectedHeading.waitFor();
  await program.locator('.exploration-owner-diff > summary').click();
  await program.getByText('与最新采用版的内容对照尚待来源确认。', { exact: true }).waitFor();
  await program.locator('.exploration-owner-evidence > summary').click();
  await program.getByText('暂时无法确认此版本的候选独立验证证据。', { exact: true }).waitFor();
  assert.equal(await program.getByText('后续任务已实际使用这个版本', { exact: true }).count(), 0);
  assert.doesNotMatch(await program.locator('.exploration-selection-heading').innerText(), /当前沿用/);
  assert.match(
    await program.getByRole('status', { name: '当前沿用', exact: true }).innerText(),
    /官方 walking ONNX baseline/,
  );
  await assertContained(program);
  const desktop = await program.boundingBox();
  await selectedHeading.scrollIntoViewIfNeeded();
  await capture(page, 'microduck-owner-candidate-desktop');

  await program.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
  assert.equal(await program.getAttribute('data-reading-view'), 'detail');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth === 320,
  );
  await assertContained(program);
  await program.getByRole('button', { name: '展开阅读 →', exact: true }).click();
  await selectedHeading.waitFor();
  await assertContained(program);
  const mobile = await program.boundingBox();
  await selectedHeading.scrollIntoViewIfNeeded();
  await capture(page, 'microduck-owner-candidate-mobile');

  const afterRead = await page.request.get(
    new URL(`/api/capability-evolution/programs/${encodeURIComponent(programId)}`, base).href,
  );
  assert.equal((await afterRead.json()).program.sequence, initialSequence);
  assert.deepEqual(programWrites, [], 'owner materials and candidate selection are read-only');
  return {
    desktop,
    mobile,
    playback,
    claim:
      'Isolated real Microduck owner publisher: a mounted Workspace discovers v4 with its actual timestamp, left miss/right hit and four decoded replays among fourteen exact videos, while football preparation stays separate from walking candidates, Program lineage, EYES, proof and adoption.',
  };
}
