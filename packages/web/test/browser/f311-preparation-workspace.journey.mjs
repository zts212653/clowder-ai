import assert from 'node:assert/strict';
import {
  assertFlatPreparationSurface,
  readFlatPreparationSurface,
  verifyPreparationVisualContract,
} from './f311-preparation-visual-contract.mjs';

export function createPmPreparationProgramFixture(programFixture, evolutionPreparationFixture, threadId) {
  const projection = programFixture('instrumenting', 12);
  const goal = '让 PM Agent 专业地推进项目，只在必要时请人介入。';
  projection.program.displayName = 'PM Agent 项目推进';
  projection.program.objectRef = {
    ownerFeatureId: 'F311',
    ownerStateRef: `capability:${encodeURIComponent(goal)}`,
  };
  projection.origin = { threadId, title: goal, createdByCatId: 'codex-sol' };
  projection.preparation = evolutionPreparationFixture();
  return projection;
}

function withoutPreparation(projection) {
  const value = structuredClone(projection);
  delete value.preparation;
  return value;
}

function interruptedSource(projection, status) {
  const value = structuredClone(projection);
  const current = value.preparation.sections.baseline_diagnosis.current;
  assert(current, 'baseline current fixture must exist');
  delete current.submission;
  current.status = status;
  return value;
}

function activityState(projection, state) {
  const value = structuredClone(projection);
  const activity = value.preparation.sections.object_map.activities[0];
  assert(activity, 'object map activity fixture must exist');
  activity.state = state;
  activity.spinning = state === 'active';
  if (state === 'unknown') delete activity.catId;
  return value;
}

async function refreshProjection(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

export async function verifyPreparationWorkspace({
  page,
  threadId,
  targetUrl,
  navigateShell,
  capture,
  assertContained,
  programFixture,
  evolutionPreparationFixture,
}) {
  const initial = createPmPreparationProgramFixture(programFixture, evolutionPreparationFixture, threadId);
  let current = initial;
  const writes = [];
  await page.route('**/api/capability-evolution/programs**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), path: url.pathname });
      return route.fulfill({ status: 405, json: { error: 'read_only_preparation_fixture' } });
    }
    if (url.pathname.endsWith('/preparation-review')) {
      return route.fulfill({ status: 404, json: { error: 'owner_publication_not_configured' } });
    }
    if (url.pathname.endsWith('/asset-review')) {
      return route.fulfill({ status: 422, json: { error: 'owner_version_review_unavailable' } });
    }
    return route.fulfill({
      json: url.pathname.endsWith('/programs') ? { programs: [withoutPreparation(current)] } : current,
    });
  });

  await page.setViewportSize({ width: 1360, height: 960 });
  await navigateShell(page, targetUrl());
  const program = page.getByTestId('evolution-program-surface');
  const journey = program.getByRole('navigation', { name: '能力进化旅程' });
  await journey.getByRole('button', { name: '准备', exact: true }).click();
  const workspace = program.getByTestId('evolution-preparation-workspace');
  await workspace
    .locator('.evolution-preparation-goal')
    .getByText('让 PM Agent 专业地推进项目，只在必要时请人介入。', { exact: false })
    .waitFor();
  await workspace.getByText('当前 Program 只绑定一个 target', { exact: false }).waitFor();
  const tabs = workspace.getByRole('tab');
  assert.equal(await tabs.count(), 4);
  const visualHierarchy = await verifyPreparationVisualContract({ page, workspace, tabs });
  await tabs.filter({ hasText: '可进化对象' }).click();

  const data = workspace.locator('[data-preparation-item="data"]');
  const environment = workspace.locator('[data-preparation-item="environment"]');
  const records = workspace.locator('[data-preparation-item="records"]');
  await data.getByText('准备中', { exact: true }).waitFor();
  await data.getByText('可改', { exact: true }).waitFor();
  assert.equal(await data.locator('[data-preparation-spinner="true"]').count(), 1);
  await environment.getByText('已有提交', { exact: true }).waitFor();
  await environment.getByText('本轮不可改', { exact: true }).waitFor();
  assert.equal(await environment.locator('[data-preparation-spinner="true"]').count(), 0);
  await records.getByText('待核实', { exact: true }).first().waitFor();
  assert.doesNotMatch(await records.locator('[data-progress-state]').innerText(), /codex-terra/u);
  assertFlatPreparationSurface(await readFlatPreparationSurface(data), 'object candidates');
  await data.locator(':scope > summary').click();
  await environment.locator(':scope > summary').click();
  await program.evaluate((element) => {
    element.scrollTop = 0;
  });
  await assertContained(program);
  const desktop = await workspace.boundingBox();
  assert.equal(
    await workspace
      .locator('.evolution-preparation-tabs')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    4,
  );
  await capture(page, 'preparation-overview-1360');
  const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await capture(page, 'preparation-visual-hierarchy-dark-1360');
  await page.evaluate((theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, initialTheme);
  await data.scrollIntoViewIfNeeded();
  await capture(page, 'preparation-object-map-1360');

  const successTab = tabs.filter({ hasText: '好坏规约' });
  await successTab.click();
  const criterion = workspace.locator('[data-preparation-criterion="professional-judgment"]');
  await criterion.locator(':scope > summary').click();
  await criterion.getByText('需校准判断', { exact: true }).first().waitFor();
  await criterion.getByText('校准裁判', { exact: true }).waitFor();
  await criterion.getByText('付薪方', { exact: true }).waitFor();
  await criterion.locator('[data-gt-source-jump="domain-precedents"]').click();
  const measurementTab = tabs.filter({ hasText: '测量与实验准备' });
  assert.equal(await measurementTab.getAttribute('aria-selected'), 'true');
  const domainSource = workspace.locator('[data-gt-source-key="domain-precedents"]');
  await domainSource.getByText('领域判断与边界判例', { exact: true }).waitFor();
  assert.equal(await domainSource.evaluate((element) => document.activeElement === element), true);
  assert.equal(
    await domainSource.evaluate((element) => getComputedStyle(element).paddingLeft),
    '10px',
    'the focused GT marker must reserve space instead of covering the first text column',
  );
  const facts = workspace.locator('[data-gt-source-key="business-facts"]');
  await facts.locator('[data-collection-state="collected"]').waitFor();
  await facts.locator('[data-validity-state="needs_review"]').waitFor();
  assert.match(await facts.locator('[data-collection-state="collected"]').innerText(), /已采集/u);
  assert.match(await facts.locator('[data-validity-state="needs_review"]').innerText(), /待核验/u);
  assert.doesNotMatch(await facts.innerText(), /可用于明确范围/u);
  const outcomes = workspace.locator('[data-gt-source-key="real-outcomes"]');
  await outcomes.locator('[data-collection-state="collecting"]').waitFor();
  await outcomes.locator('[data-validity-state="unconfirmed"]').waitFor();
  assert.match(await outcomes.locator('[data-collection-state="collecting"]').innerText(), /采集中/u);
  assert.match(await outcomes.locator('[data-validity-state="unconfirmed"]').innerText(), /范围声明待核实/u);
  await outcomes.getByText('沉默不能判为满意。', { exact: true }).waitFor();
  assertFlatPreparationSurface(await readFlatPreparationSurface(outcomes), 'GT sources');
  const missingSurface = await outcomes.locator('.evolution-preparation-unknowns').evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, borderRadius: style.borderRadius };
  });
  assert.deepEqual(
    missingSurface,
    { backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '0px' },
    'missing or disputed evidence must be a hairline section, not another inset card',
  );
  await capture(page, 'preparation-gt-sources-1360');
  await workspace.getByRole('button', { name: '返回规约：专业判断', exact: true }).click();
  assert.equal(await criterion.evaluate((node) => node.open), true);
  assert.equal(await criterion.locator('summary').evaluate((node) => document.activeElement === node), true);

  const baselineTab = tabs.filter({ hasText: '基线与初步诊断' });
  await baselineTab.click();
  await workspace.getByText('依赖的准备稿已经变化', { exact: false }).waitFor();
  await workspace.locator('.evolution-preparation-history > summary').click();
  await workspace.locator('.evolution-preparation-history-entry > summary').click();
  await workspace.getByText('baseline_diagnosis 旧稿', { exact: true }).first().waitFor();
  await capture(page, 'preparation-stale-history-1360');

  await successTab.click();
  const outcomeCriterion = workspace.locator('[data-preparation-criterion="project-outcome"]');
  await outcomeCriterion.locator(':scope > summary').click();
  await outcomeCriterion.locator('[data-gt-source-jump="real-outcomes"]').click();
  await program.evaluate((element) => {
    element.scrollTop = 260;
    element.dispatchEvent(new Event('scroll'));
  });
  await navigateShell(page, targetUrl());
  const restoredProgram = page.getByTestId('evolution-program-surface');
  const restoredWorkspace = restoredProgram.getByTestId('evolution-preparation-workspace');
  const restoredMeasurement = restoredWorkspace.getByRole('tab').filter({ hasText: '测量与实验准备' });
  await restoredMeasurement.waitFor();
  assert.equal(await restoredMeasurement.getAttribute('aria-selected'), 'true');
  assert.equal(
    await restoredWorkspace
      .locator('[data-gt-source-key="real-outcomes"]')
      .evaluate((element) => document.activeElement === element),
    true,
  );
  const reading = await page.evaluate(() => JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs);
  assert.equal(reading[initial.program.programId].preparationSection, 'measurement_plan');
  assert.equal(reading[initial.program.programId].preparationGtSourceKey, 'real-outcomes');
  assert.doesNotMatch(JSON.stringify(reading[initial.program.programId]), /submission|专业地推进项目/u);

  await restoredProgram.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
  await restoredProgram.getByRole('button', { name: '展开阅读 →', exact: true }).click();
  await restoredMeasurement.waitFor();
  assert.equal(await restoredMeasurement.getAttribute('aria-selected'), 'true');

  const widths = [];
  for (const width of [416, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth === expected,
      width,
    );
    await restoredProgram.evaluate((element) => {
      element.scrollTop = 0;
    });
    await assertContained(restoredProgram);
    await assertContained(restoredWorkspace);
    for (const tab of await tabs.all()) await assertContained(tab);
    const columns = await restoredWorkspace
      .locator('.evolution-preparation-tabs')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    assert.equal(columns, width === 320 ? 1 : 2);
    widths.push({ viewport: width, columns, workspace: await restoredWorkspace.boundingBox() });
    await capture(page, `preparation-workspace-${width}`);
    await restoredWorkspace.getByRole('tab').first().scrollIntoViewIfNeeded();
    await capture(page, `preparation-tabs-${width}`);
  }

  current = initial;
  await refreshProjection(page);
  await restoredWorkspace.getByRole('tab').filter({ hasText: '可进化对象' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const spinner = restoredWorkspace.locator('[data-preparation-item="data"] [data-preparation-spinner="true"]');
  await spinner.waitFor();
  assert.equal(await spinner.evaluate((element) => getComputedStyle(element).animationName), 'none');

  current = activityState(initial, 'terminal');
  await refreshProjection(page);
  await restoredWorkspace.locator('[data-preparation-item="data"]').getByText('运行已结束', { exact: true }).waitFor();
  assert.equal(await restoredWorkspace.locator('[data-preparation-spinner="true"]').count(), 0);
  current = activityState(initial, 'unknown');
  await refreshProjection(page);
  const unknownData = restoredWorkspace.locator('[data-preparation-item="data"]');
  await unknownData.getByText('工作状态待核实', { exact: true }).waitFor();
  assert.doesNotMatch(await unknownData.locator('[data-progress-state]').innerText(), /codex-terra/u);

  await page.setViewportSize({ width: 1360, height: 960 });
  current = interruptedSource(initial, 'materializing');
  await refreshProjection(page);
  await restoredWorkspace.getByRole('tab').filter({ hasText: '基线与初步诊断' }).click();
  const materializing = restoredWorkspace.locator('[data-current-source-status="materializing"]');
  await materializing.getByText('提交意图已经登记', { exact: false }).waitFor();
  assert.equal(await materializing.locator('[data-preparation-spinner="true"]').count(), 0);
  current = interruptedSource(initial, 'source_unavailable');
  await refreshProjection(page);
  const unavailable = restoredWorkspace.locator('[data-current-source-status="source_unavailable"]');
  await unavailable.getByText('来源已不可用', { exact: false }).waitFor();
  assert.doesNotMatch(await unavailable.innerText(), /当前只能形成初步诊断/u);
  await capture(page, 'preparation-source-unavailable-1360');

  assert.deepEqual(writes, [], 'the preparation reading journey must never send Program writes');
  return {
    desktop,
    widths,
    reducedMotion: 'none',
    visualHierarchy,
    sequenceUnchanged: initial.program.sequence,
    writes: writes.length,
    claim: 'Real F307 shell with strict synthetic owner projection; not Alpha or a production outcome.',
  };
}
