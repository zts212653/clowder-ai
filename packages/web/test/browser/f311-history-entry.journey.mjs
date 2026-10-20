import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertHistoricalMapGeometry, assertSelectedCardInsideCanvas } from './f311-history-map-assertions.mjs';
import { assetReview, PROGRAM_ID } from './f311-v2-closure.fixture.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

async function rejectFixtureWrite(route, request, url, writes) {
  const protectedPath =
    url.pathname.startsWith('/api/capability-evolution/programs') ||
    url.pathname.startsWith('/api/eval-repair-proposals');
  if (request.method() === 'GET') return false;
  if (!protectedPath) return false;
  writes.push({ method: request.method(), path: url.pathname });
  await route.fulfill({ status: 405, json: { error: 'isolated_read_only_fixture' } });
  return true;
}

function v3HistoryIndex(rawIndex) {
  const next = structuredClone(rawIndex);
  next.schemaVersion = 3;
  next.story = {
    updated: '2026-10-19',
    overviewMarkdown: '### 这条历史怎么读\n\n作者正文已经与页面能力分开：\n\n- 可以直接写列表\n- 可以放安全链接',
    sources: structuredClone(rawIndex.story.sources),
    steps: rawIndex.story.nodes.map((node, index) => {
      const sourceIds = [
        ...new Set([
          ...node.changes.map((change) => change.sourceId),
          ...node.parents.map((parent) => parent.sourceId),
        ]),
      ];
      return {
        stepId: node.id,
        date: node.when,
        title: node.title,
        parentEdges: node.parents.map((parent) => ({
          parentStepId: parent.nodeId,
          sourceId: parent.sourceId,
          reason: parent.reason,
        })),
        sourceIds: sourceIds.length ? sourceIds : [rawIndex.story.sources[0].id],
        bodyMarkdown: [
          '### 我们看见了什么',
          '',
          node.summary,
          '',
          '### 我们改了什么',
          '',
          ...node.changes.flatMap((change) => [`- **${change.label}**：${change.detail}`]),
          '- [查看安全链接](https://github.com/zts212653/clowder-ai)',
          '',
          '### 仍待确认',
          '',
          index === 0 ? 'SENTINEL_V3_STEP_BODY：后续效果仍需真实使用确认。' : '后续效果仍需真实使用确认。',
        ].join('\n'),
        ...(index === 0 ? { futureStepPresentation: { emphasis: 'future' } } : {}),
      };
    }),
    cases: rawIndex.story.cases.map((entry, index) => ({
      caseId: entry.caseId,
      stepId: entry.nodeId,
      title: entry.title ?? entry.problem,
      sourceIds: entry.sourceIds,
      bodyMarkdown: [
        '### 踩了什么坑',
        '',
        entry.problem,
        '',
        '### 当时怎么应对',
        '',
        `1. ${entry.response}`,
        '2. 保留来源与未确定边界。',
        '',
        '### 后来怎样',
        '',
        entry.outcome,
        '',
        '[查看案例说明](https://github.com/zts212653/clowder-ai)',
        ...(index === 0 ? ['', 'SENTINEL_V3_CASE_BODY'] : []),
      ].join('\n'),
      ...(index === 0 ? { futureCasePresentation: true } : {}),
    })),
  };
  next.story.sources[0].futureSourcePresentation = 'future';
  return next;
}

async function createHistoryOwner(rawIndex, nextIndex) {
  const [{ HarnessHistoryPublicationOwner }, { MemoryHarnessHistoryPublicationStore }] = await Promise.all([
    import(
      '../../../api/src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.ts'
    ),
    import(
      '../../../api/src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-store.ts'
    ),
  ]);
  const revision = 'c'.repeat(40);
  const nextRevision = 'd'.repeat(40);
  const source = {
    baseline: async () => revision,
    read: async (requested) => {
      assert.ok([revision, nextRevision].includes(requested));
      return requested === nextRevision ? nextIndex : rawIndex;
    },
    acquire: async (requested) => {
      assert.equal(requested, nextRevision);
      return nextIndex;
    },
    ignoredFieldPaths: async (requested) =>
      requested === nextRevision
        ? [
            '/story/cases/0/futureCasePresentation',
            '/story/sources/0/futureSourcePresentation',
            '/story/steps/0/futureStepPresentation',
          ]
        : [],
  };
  return {
    owner: new HarnessHistoryPublicationOwner({
      store: new MemoryHarnessHistoryPublicationStore(),
      source,
      now: () => '2026-10-19T20:00:00.000Z',
    }),
    nextRevision,
  };
}

async function fulfillProgramRead({ route, request, url, projection, programPath, historyOwner }) {
  if (request.method() !== 'GET') return false;
  if (url.pathname === '/api/capability-evolution/programs') {
    await route.fulfill({ json: { programs: [projection] } });
    return true;
  }
  if (url.pathname === programPath) {
    await route.fulfill({ json: projection });
    return true;
  }
  if (url.pathname === `${programPath}/asset-review`) {
    await route.fulfill({ json: assetReview(url, projection) });
    return true;
  }
  if (url.pathname === `${programPath}/preparation-review`) {
    await route.fulfill({
      status: 503,
      json: {
        schemaVersion: 1,
        status: 'unavailable',
        programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
        objectRef: projection.program.objectRef,
        blockers: [{ code: 'isolated_owner_read_unavailable', ownerRef: projection.program.objectRef }],
      },
    });
    return true;
  }
  if (url.pathname !== `${programPath}/exploration`) return false;
  const input = {
    programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
    objectRef: projection.program.objectRef,
  };
  for (const key of ['selectedSourceRef', 'selectedNodeRef', 'selectedExperimentRef', 'comparisonExperimentRef']) {
    const value = url.searchParams.get(key);
    if (value) input[key] = JSON.parse(value);
  }
  const publication = await historyOwner.read(input);
  await route.fulfill({ status: publication.status === 'resolved' ? 200 : 422, json: publication });
  return true;
}

function installOldReading(context) {
  return context.addInitScript((programId) => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    localStorage.setItem(
      'f311-program-reading-v1',
      JSON.stringify({
        state: {
          programs: {
            [programId]: {
              view: 'judgment',
              scroll: { detail: 0, judgment: 0, history: 0 },
              journeyMoment: 2,
              exploration: {
                selectedNodeRef: {
                  ownerFeatureId: 'F314',
                  ownerStateRef: 'harness-history:release:H01',
                  version: 'old',
                },
                draft: { intent: 'explore', text: '保留的旧想法 sentinel-f311-history' },
              },
            },
          },
        },
        version: 0,
      }),
    );
  }, PROGRAM_ID);
}

export async function verifyHistoryEntryJourney({ fixture, browser, capture }) {
  const snapshots = JSON.parse(
    await readFile(new URL('./fixtures/f311-v2-program-snapshots.json', import.meta.url), 'utf8'),
  );
  const snapshot = snapshots.programs.find((entry) => entry.program.programId === PROGRAM_ID);
  assert(snapshot, 'F314 Program snapshot must remain registered');
  const projection = structuredClone(snapshot);
  const rawIndex = JSON.parse(
    await readFile(
      new URL('../../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
      'utf8',
    ),
  );
  const authoredStory = structuredClone(rawIndex.story);
  assert.equal(rawIndex.story.nodes.length, 12, 'the reader fixture must consume all authored steps');
  assert.equal(rawIndex.story.cases.length, 27, 'the reader fixture must consume all authored cases');
  assert.equal(
    new Set(rawIndex.story.cases.map((entry) => entry.caseId)).size,
    rawIndex.cases.length,
    'the authored story must still cover every published archive case exactly once',
  );
  const linkedCase = rawIndex.cases.find((entry) => entry.link && entry.citedMemberCommits.length);
  assert(linkedCase, 'reviewed F314 history must retain a case with an exact cited commit');
  const narrative = rawIndex.story.cases.find((entry) => entry.caseId === linkedCase.caseId);
  assert(narrative, 'reviewed F314 story must place the cited case in one readable step');
  const step = rawIndex.story.nodes.find((entry) => entry.id === narrative.nodeId);
  assert(step, 'reviewed F314 story must expose the cited case step');

  const v3Index = v3HistoryIndex(rawIndex);
  const { owner: historyOwner, nextRevision } = await createHistoryOwner(rawIndex, v3Index);
  const programPath = `/api/capability-evolution/programs/${encodeURIComponent(PROGRAM_ID)}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installOldReading(context);
  const writes = [];
  const errors = [];
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await rejectFixtureWrite(route, request, url, writes)) return;
    if (await fulfillProgramRead({ route, request, url, projection, programPath, historyOwner })) return;
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(`${fixture.apiUrl}/api/session`);
    await page.goto(`${fixture.webUrl}/thread/${CONTRACT_THREAD_ID}?shell=v2`);
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-v2').waitFor();
    await page.getByTestId('settings-entry-evolution').click();
    const home = page.getByTestId('capability-evolution-workspace');
    await home.getByTestId(`capability-evolution-program-${PROGRAM_ID}`).click();
    let detail = home.getByTestId('capability-evolution-program-detail');

    const recovery = detail.getByRole('region', { name: '最新历史可读' });
    const evaluation = detail.getByRole('complementary', { name: '项目效果评估状态' });
    await recovery.waitFor();
    await evaluation.waitFor();
    assert.ok((await recovery.innerText()).includes('最新历史已经发布，可以直接阅读'));
    assert.ok((await evaluation.innerText()).includes('不是查看已发布探索记录的前置条件'));
    assert.equal(
      await recovery.evaluate((node) => {
        const status = document.querySelector('[aria-label="项目效果评估状态"]');
        return Boolean(status && node.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
      true,
      'published history and its recovery action must precede evaluation gaps',
    );
    const before = await page.evaluate(
      (programId) =>
        JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs[programId].exploration
          .selectedNodeRef,
      PROGRAM_ID,
    );
    assert.equal(before.version, 'old', 'opening the Program must preserve the saved historical coordinate');
    await capture(page, 'history-entry-recovery-before-evaluation');

    await recovery.getByRole('button', { name: '打开最新历史', exact: true }).click();
    const summary = detail.getByRole('region', { name: '错题谱系' });
    await summary.waitFor();
    assert.ok((await summary.innerText()).includes('12 步 · 27 道错题'));
    assert.ok((await summary.innerText()).includes(authoredStory.overview));
    const recovered = await page.evaluate(
      (programId) => JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs[programId].exploration,
      PROGRAM_ID,
    );
    assert.notEqual(recovered.selectedNodeRef.version, 'old');
    assert.ok(recovered.selectedSourceRef, 'explicit recovery must persist the owner-issued publication');
    assert.equal(recovered.draft.text, '保留的旧想法 sentinel-f311-history');
    await capture(page, 'history-entry-latest-readable');

    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    let main = page.locator('[data-testid="evolution-program-surface"]:visible');
    const history = main.getByTestId('evolution-exploration-workspace');
    await history.waitFor();
    const visibleHistory = await history.innerText();
    assert.ok(visibleHistory.includes(authoredStory.overview));
    assert.doesNotMatch(
      visibleHistory,
      /sha256:|harness-history:|F314 owner 核对|[a-f0-9]{40}/,
      'implementation coordinates and hashes must stay inside collapsed evidence',
    );
    const toolbar = history.getByRole('toolbar', { name: '谱系导航' });
    assert.deepEqual(await toolbar.locator(':scope > button').allTextContents(), ['看全图']);
    const more = toolbar.locator(':scope > details > summary');
    assert.equal(await more.innerText(), '更多');
    await more.click();
    await toolbar.getByLabel('谱系缩放').waitFor();
    await toolbar.getByLabel('谱系排列').waitFor();

    await assertHistoricalMapGeometry(history, authoredStory);
    const stepPicker = history.getByLabel('选择阅读步骤');
    for (const root of authoredStory.nodes.filter((node, index) => index > 0 && node.parents.length === 0)) {
      const origin = authoredStory.cases.find((entry) => entry.nodeId === root.id);
      assert(origin, `independent start ${root.id} needs an authored counterexample`);
      const rootOption = await stepPicker.locator('option', { hasText: root.title }).getAttribute('value');
      assert(rootOption, `independent start ${root.id} must remain selectable`);
      await stepPicker.selectOption(rootOption);
      await toolbar.getByRole('button', { name: '定位阅读版' }).click();
      await history
        .locator('.exploration-node-wrap[data-selected="true"] .exploration-node-meta', {
          hasText: `起于：${origin.title}`,
        })
        .waitFor();
    }
    const option = await stepPicker.locator('option', { hasText: step.title }).getAttribute('value');
    assert(option, 'F314 history must expose the cited case step');
    await stepPicker.selectOption(option);
    await toolbar.getByRole('button', { name: '定位阅读版' }).click();
    await assertSelectedCardInsideCanvas(history);
    await history.getByRole('button', { name: `阅读 ${step.title}`, exact: true }).click();
    assert.equal(await stepPicker.inputValue(), option, 'clicking a map node must open that exact authored step');
    await history.locator('.exploration-version-nav').scrollIntoViewIfNeeded();
    await capture(page, 'history-entry-desktop-map-readable');

    await page.getByTestId('workspace-focus-enter').click();
    await page.getByTestId('workspace-focus-exit').waitFor();
    await toolbar.getByRole('button', { name: '看全图', exact: true }).click();
    await capture(page, 'history-entry-focus-map-readable');

    await page.setViewportSize({ width: 390, height: 844 });
    await more.waitFor();
    const narrow = await history.evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.ok(narrow.scrollWidth <= narrow.clientWidth + 1, 'the history reader must not overflow at 390px');
    await capture(page, 'history-entry-narrow-map-readable');
    await history.getByRole('button', { name: '收起地图', exact: true }).click();
    await stepPicker.waitFor();
    assert.equal(await stepPicker.inputValue(), option, 'narrow navigation must preserve the exact selected step');
    await capture(page, 'history-entry-narrow-readable');

    const selectedCase = history.locator('.exploration-history-case-toggle', {
      hasText: narrative.title,
    });
    await selectedCase.waitFor();
    if ((await selectedCase.getAttribute('aria-expanded')) !== 'true') await selectedCase.click();
    const caseBody = selectedCase.locator('xpath=following-sibling::*[1]');
    await caseBody.waitFor();
    const sources = caseBody.getByText('历史原件与后续来源', { exact: true }).locator('..');
    await sources.locator(':scope > summary').click();
    const caseSource = sources.locator('details.evolution-source', { hasText: '案例原文' });
    await caseSource.locator(':scope > summary').click();
    assert.ok(
      (await caseSource.getByRole('link', { name: '打开来源' }).getAttribute('href')).includes(linkedCase.link),
    );
    const citation = sources.locator('details.evolution-source', { hasText: '原文引用' }).first();
    await citation.locator(':scope > summary').click();
    assert.equal(
      await citation.getByRole('link', { name: '打开来源' }).getAttribute('href'),
      `https://github.com/zts212653/clowder-ai/commit/${linkedCase.citedMemberCommits[0].fullSha}`,
    );
    await capture(page, 'history-entry-exact-source');

    const publicationInput = {
      programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
      objectRef: projection.program.objectRef,
    };
    const publication = await historyOwner.publish(
      publicationInput,
      {
        action: 'publish',
        expectedRevision: 0,
        sourceRevision: nextRevision,
        clientMessageId: 'browser-publish-v3',
        reason: '浏览器保持打开时发布作者 Markdown',
      },
      { actorRef: 'cat:codex-astra', originRef: 'thread:fixture:invocation:browser-v3' },
    );
    assert.equal(publication.outcome, 'appended');
    assert.equal(publication.attempt.status, 'published');
    assert.deepEqual(publication.attempt.ignoredFieldPaths, [
      '/story/cases/0/futureCasePresentation',
      '/story/sources/0/futureSourcePresentation',
      '/story/steps/0/futureStepPresentation',
    ]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const update = history.getByRole('button', { name: '查看新版', exact: true });
    await update.waitFor();
    await update.click();
    await history.getByText('这条历史怎么读', { exact: true }).waitFor();
    assert.equal(await history.getByText('可以直接写列表', { exact: true }).count(), 1);
    const selectedV3Step = v3Index.story.steps.find((entry) => entry.stepId === step.id);
    assert(selectedV3Step);
    const selectedV3Option = await stepPicker
      .locator('option', { hasText: selectedV3Step.title })
      .getAttribute('value');
    assert(selectedV3Option, 'the published v3 step must remain selectable');
    assert.notEqual(selectedV3Option, option, 'accepting the publication must replace the bundled source coordinate');
    assert.equal(
      JSON.parse(selectedV3Option)[3],
      `publication:1:${nextRevision}`,
      'the selected logical step must bind the exact newly published source',
    );
    assert.ok((await history.innerText()).includes(selectedV3Step.bodyMarkdown.split('\n')[2]));
    const selectedMapNode = history.locator('.exploration-node-wrap[data-selected="true"] .exploration-node');
    assert.equal(await selectedMapNode.locator('.exploration-node-period').innerText(), selectedV3Step.date);
    assert.equal(await selectedMapNode.locator('.exploration-node-heading').innerText(), selectedV3Step.title);
    assert.doesNotMatch(await selectedMapNode.innerText(), /SENTINEL_V3_STEP_BODY/);
    assert.equal(
      await history.getByRole('link', { name: '查看安全链接', exact: true }).getAttribute('href'),
      'https://github.com/zts212653/clowder-ai',
    );
    const selectedV3Case = v3Index.story.cases.find((entry) => entry.caseId === narrative.caseId);
    assert(selectedV3Case);
    const v3CaseToggle = history.locator('.exploration-history-case-toggle', { hasText: selectedV3Case.title });
    if ((await v3CaseToggle.getAttribute('aria-expanded')) !== 'true') await v3CaseToggle.click();
    const v3CaseBody = v3CaseToggle.locator('xpath=following-sibling::*[1]');
    await v3CaseBody.getByText('踩了什么坑', { exact: true }).waitFor();
    assert.equal(await v3CaseBody.locator('ol > li').count(), 2);
    assert.equal(
      await v3CaseBody.getByRole('link', { name: '查看案例说明', exact: true }).getAttribute('href'),
      'https://github.com/zts212653/clowder-ai',
    );
    assert.doesNotMatch(await v3CaseBody.innerText(), /后来怎样了/);
    await capture(page, 'history-entry-v3-same-process-publication');

    await main.getByRole('button', { name: '← 返回详情', exact: true }).click();
    detail = page.locator('[data-testid="capability-evolution-program-detail"]:visible');
    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    main = page.locator('[data-testid="evolution-program-surface"]:visible');
    const restoredHistory = main.getByTestId('evolution-exploration-workspace');
    await restoredHistory.waitFor();
    assert.equal(
      await main.getByLabel('选择阅读步骤').inputValue(),
      selectedV3Option,
      'return must restore the same step at the explicitly accepted publication',
    );
    const restoredLoading = restoredHistory.getByText('正在读取这道错题…', { exact: true });
    if (await restoredLoading.isVisible()) await restoredLoading.waitFor({ state: 'hidden' });
    const restored = await page.evaluate(
      (programId) => JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs[programId].exploration,
      PROGRAM_ID,
    );
    assert.equal(restored.draft.text, '保留的旧想法 sentinel-f311-history');
    await capture(page, 'history-entry-return-restored');

    assert.deepEqual(writes, [], 'reading and recovery must not mutate the Program or proposal');
    assert.deepEqual(errors, []);
    return {
      programId: PROGRAM_ID,
      selectedStep: selectedV3Option,
      previousBundledStep: option,
      stepCount: authoredStory.nodes.length,
      caseCount: authoredStory.cases.length,
      sameProcessPublication: {
        sourceRevision: nextRevision,
        ignoredFieldPaths: publication.attempt.ignoredFieldPaths,
        processRestarted: false,
      },
      writes,
      pageErrors: errors,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'f311-history-entry-failure',
        url: page.url(),
        body: await page.locator('body').innerText(),
        writes,
        errors,
      }),
    );
    await capture(page, 'history-entry-failure');
    throw error;
  } finally {
    await context.close();
  }
}
