import assert from 'node:assert/strict';
import { EVOLUTION_PREPARATION_SECTIONS } from '@cat-cafe/shared';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

async function waitForResponsiveWorkspaceLayout(page, workspace, viewportWidth) {
  await workspace.waitFor({ state: 'visible' });
  await page.waitForFunction(
    (minimum) =>
      (document.querySelector('[data-testid="capability-evolution-workspace"]')?.clientWidth ?? 0) >= minimum,
    Math.min(viewportWidth, 320),
  );
}

/** Unnamed, unavailable-owner fixtures matching the reported shape. Never owner outcome proof. */
export async function verifyUnnamedWorkspaceReadability({
  page,
  base,
  threadId,
  programFixture,
  navigateShell,
  capture,
  assertContained,
}) {
  const make = (stage, digit, title) => {
    const projection = programFixture(stage);
    const programId = `evolution-program:${digit.repeat(32)}`;
    projection.program = { ...projection.program, programId, displayName: undefined, currentAssetVersionRefs: [] };
    projection.cycles = projection.cycles.map((cycle) => ({ ...cycle, programId }));
    projection.origin = { threadId: `thread-source-${digit}`, title };
    projection.blockers =
      stage === 'constituting'
        ? [{ code: 'goal_certificate_missing', ownerFeatureId: 'F311', message: 'goal missing' }]
        : [];
    projection.observation = {
      status: 'insufficient',
      connectedEyes: [],
      gaps: [
        { code: 'trajectory_ref_missing', ownerFeatureId: 'F299', message: 'trajectory missing' },
        { code: 'heterogeneous_owner_surfaces_missing', ownerFeatureId: 'F311', message: 'independent source missing' },
      ],
    };
    projection.preparation = {
      schemaVersion: 1,
      programId,
      sections: Object.fromEntries(
        EVOLUTION_PREPARATION_SECTIONS.map((section) => [
          section,
          {
            section,
            identityRef: { ownerFeatureId: 'F311', ownerStateRef: `preparation-submission:${programId}:${section}` },
            current: null,
            history: [],
            activities: [],
          },
        ]),
      ),
    };
    return projection;
  };
  const programs = [
    make('instrumenting', 'a', '让审阅始终对齐原始需求 · Q7冷启动实验'),
    make('constituting', 'b', '投资人路演表达实验'),
  ];
  let listReads = 0;
  let detailReads = 0;
  await page.route('**/api/capability-evolution/programs**', async (route) => {
    assert.equal(route.request().method(), 'GET');
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/asset-review'))
      return route.fulfill({ status: 422, json: { error: 'owner_version_review_unavailable' } });
    const isList = url.pathname.endsWith('/programs');
    if (isList) listReads += 1;
    else {
      detailReads += 1;
      // Reproduce the real boundary: lightweight list responses arrive before complete detail reads.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const body = isList
      ? { programs: programs.map(({ preparation: _preparation, ...summary }) => summary) }
      : programs.find((entry) => url.pathname.endsWith(encodeURIComponent(entry.program.programId)));
    return route.fulfill({ status: body ? 200 : 404, json: body ?? { error: 'program_not_found' } });
  });
  await navigateShell(page, new URL(`/thread/${threadId}`, base).href);
  await ensureWorkspaceOpen(page);
  await page.getByText('能力进化', { exact: true }).first().click();
  const workspace = page.getByTestId('capability-evolution-workspace');
  const first = workspace.getByTestId(`capability-evolution-program-${programs[0].program.programId}`);
  const second = workspace.getByTestId(`capability-evolution-program-${programs[1].program.programId}`);
  await first.getByText('来自「让审阅始终对齐原始需求 · Q7冷启动实验」', { exact: true }).waitFor();
  assert.match(await first.innerText(), /准备/);
  assert.match(await second.innerText(), /准备目标/);
  assert.match(await first.innerText(), /真实任务的执行记录/);
  assert.doesNotMatch(await second.innerText(), /真实任务的执行记录/);
  assert.doesNotMatch(await workspace.innerText(), /aaaaaaaa|bbbbbbbb|项评估条件待完成/);
  const widths = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await waitForResponsiveWorkspaceLayout(page, workspace, width);
    await assertContained(workspace);
    for (const row of [first, second]) {
      await assertContained(row);
      assert.equal(await row.locator('.truncate').count(), 0, 'project identity and next step cannot be ellipsized');
    }
    await capture(page, `readability-home-${width}`);
    widths.push({ viewport: width, workspace: await workspace.boundingBox() });
  }
  await first.click();
  await workspace
    .getByRole('heading', { name: '来自「让审阅始终对齐原始需求 · Q7冷启动实验」', exact: true })
    .waitFor();
  assert.equal(
    await workspace.getByRole('link', { name: '回到发起对话 ↗' }).getAttribute('href'),
    '/thread/thread-source-a',
  );
  await workspace.getByRole('heading', { name: '还没有提交', exact: true }).waitFor();
  await workspace.evaluate((element) => {
    const states = [];
    const record = () => {
      const state = [...element.querySelectorAll('[data-preparation-section-state]')]
        .map((node) => node.getAttribute('data-preparation-section-state'))
        .join(',');
      if (states.at(-1) !== state) states.push(state);
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__f311PreparationReadProbe = { states, observer };
  });
  const initialListReads = listReads;
  const initialDetailReads = detailReads;
  for (let poll = 0; poll < 3; poll += 1) {
    await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/capability-evolution/programs');
    await page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(encodeURIComponent(programs[0].program.programId)),
    );
  }
  const states = await page.evaluate(() => {
    const probe = window.__f311PreparationReadProbe;
    probe.observer.disconnect();
    delete window.__f311PreparationReadProbe;
    return probe.states;
  });
  assert(listReads - initialListReads >= 3);
  assert(detailReads - initialDetailReads >= 3);
  assert.deepEqual(
    states,
    ['not_started,not_started,not_started,not_started'],
    'summary polling must not erase detail',
  );
  await capture(page, 'readability-detail');
  return { widths, preparationPolling: { listReads, detailReads, states } };
}

/**
 * Three named real-object Programs side by side in one home anatomy.
 * Mirrors the unit fixture shape in CapabilityEvolutionWorkspace.test.tsx;
 * contract fixture evidence, never owner truth or Alpha outcome proof.
 */
export async function verifyThreeProgramsSideBySide({
  page,
  base,
  threadId,
  programFixture,
  navigateShell,
  capture,
  assertContained,
}) {
  const make = (digit, displayName, ownerStateRef, stage, blockers) => {
    const projection = programFixture(stage);
    const programId = `evolution-program:${digit.repeat(32)}`;
    projection.program = {
      ...projection.program,
      programId,
      displayName,
      objectRef: { ownerFeatureId: 'F311', ownerStateRef },
      currentAssetVersionRefs: [],
    };
    projection.cycles = projection.cycles.map((cycle) => ({ ...cycle, programId }));
    projection.blockers = blockers;
    return projection;
  };
  const programs = [
    make('a', '研发协作改进', 'capability:development-process-harness-effectiveness', 'instrumenting', [
      { code: 'measurement_certificate_missing', ownerFeatureId: 'F267', message: 'measurement certificate missing' },
      { code: 'promotion_holdout_missing', ownerFeatureId: 'F311', message: 'promotion holdout missing' },
    ]),
    make('b', 'Microduck 行走稳定性', 'capability:microduck-walking-stability', 'constituting', [
      { code: 'measurement_certificate_missing', ownerFeatureId: 'F267', message: 'measurement certificate missing' },
    ]),
    make('c', '投资人路演效果', 'capability:f311-investor-roadshow-expression', 'observing', []),
  ];
  await page.route('**/api/capability-evolution/programs**', async (route) => {
    assert.equal(route.request().method(), 'GET');
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/asset-review'))
      return route.fulfill({ status: 422, json: { error: 'owner_version_review_unavailable' } });
    const isList = url.pathname.endsWith('/programs');
    const body = isList
      ? { programs }
      : programs.find((entry) => url.pathname.endsWith(encodeURIComponent(entry.program.programId)));
    return route.fulfill({ status: body ? 200 : 404, json: body ?? { error: 'program_not_found' } });
  });
  await navigateShell(page, new URL(`/thread/${threadId}`, base).href);
  await ensureWorkspaceOpen(page);
  await page.getByText('能力进化', { exact: true }).first().click();
  const workspace = page.getByTestId('capability-evolution-workspace');
  const [processRow, microduckRow, roadshowRow] = programs.map((entry) =>
    workspace.getByTestId(`capability-evolution-program-${entry.program.programId}`),
  );
  await roadshowRow.getByText('投资人路演效果', { exact: true }).waitFor();
  assert.match(await processRow.innerText(), /研发协作改进/);
  assert.match(await processRow.innerText(), /还需要：约定怎样判断改进有效、留出未参与选择的验证场景。/);
  assert.match(await microduckRow.innerText(), /Microduck 行走稳定性/);
  assert.match(await microduckRow.innerText(), /还需要：约定怎样判断改进有效。/);
  assert.match(await roadshowRow.innerText(), /正在收集本轮证据/);
  const focus = workspace.locator('.evolution-focus');
  assert.match(await focus.innerText(), /准备评估/);
  assert.match(await focus.innerText(), /研发协作改进/);
  await focus.getByRole('button', { name: '查看进展', exact: true }).waitFor();
  assert.doesNotMatch(await workspace.innerText(), /三个阶段|aaaaaaaa|bbbbbbbb|cccccccc/);
  const widths = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await waitForResponsiveWorkspaceLayout(page, workspace, width);
    await assertContained(workspace);
    for (const row of [processRow, microduckRow, roadshowRow]) {
      await assertContained(row);
      assert.equal(await row.locator('.truncate').count(), 0, 'program identity and next step cannot be ellipsized');
    }
    await capture(page, `three-programs-${width}`);
    widths.push({ viewport: width, workspace: await workspace.boundingBox() });
  }
  return { widths, programs: programs.map((entry) => entry.program.programId) };
}
