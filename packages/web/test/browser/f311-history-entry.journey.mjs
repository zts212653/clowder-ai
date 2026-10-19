import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

async function createHistoryOwner(rawIndex) {
  const [{ HarnessHistoryPublicationOwner }, { MemoryHarnessHistoryPublicationStore }] = await Promise.all([
    import(
      '../../../api/src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.ts'
    ),
    import(
      '../../../api/src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-store.ts'
    ),
  ]);
  const revision = 'c'.repeat(40);
  const source = {
    baseline: async () => revision,
    read: async (requested) => {
      assert.equal(requested, revision);
      return rawIndex;
    },
    acquire: async (requested) => {
      assert.equal(requested, revision);
      return rawIndex;
    },
  };
  return new HarnessHistoryPublicationOwner({
    store: new MemoryHarnessHistoryPublicationStore(),
    source,
    now: () => '2026-10-18T07:00:00.000Z',
  });
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
      new URL('../../../../docs/discussions/f314-incident-archive/lineage/lineage-index.json', import.meta.url),
      'utf8',
    ),
  );
  const linkedCase = rawIndex.cases.find((entry) => entry.link && entry.citedMemberCommits.length);
  assert(linkedCase, 'reviewed F314 history must retain a case with an exact cited commit');
  const narrative = rawIndex.story.cases.find((entry) => entry.caseId === linkedCase.caseId);
  assert(narrative, 'reviewed F314 story must place the cited case in one readable step');
  const step = rawIndex.story.nodes.find((entry) => entry.id === narrative.nodeId);
  assert(step, 'reviewed F314 story must expose the cited case step');

  const historyOwner = await createHistoryOwner(rawIndex);
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
    assert.ok((await summary.innerText()).includes('11 步 · 26 道错题'));
    const recovered = await page.evaluate(
      (programId) => JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs[programId].exploration,
      PROGRAM_ID,
    );
    assert.notEqual(recovered.selectedNodeRef.version, 'old');
    assert.ok(recovered.selectedSourceRef, 'explicit recovery must persist the owner-issued publication');
    await capture(page, 'history-entry-latest-readable');

    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    let main = page.locator('[data-testid="evolution-program-surface"]:visible');
    const history = main.getByTestId('evolution-exploration-workspace');
    await history.waitFor();
    const stepPicker = history.getByLabel('选择阅读步骤');
    const option = await stepPicker.locator('option', { hasText: step.title }).getAttribute('value');
    assert(option, 'F314 history must expose the cited case step');
    await stepPicker.selectOption(option);

    const selectedCase = history.locator('.exploration-history-case-toggle', {
      hasText: narrative.problem.slice(0, 80),
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

    await main.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
    detail = page.locator('[data-testid="capability-evolution-program-detail"]:visible');
    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    main = page.locator('[data-testid="evolution-program-surface"]:visible');
    await main.getByTestId('evolution-exploration-workspace').waitFor();
    assert.equal(await main.getByLabel('选择阅读步骤').inputValue(), option, 'return must restore the exact step');
    await capture(page, 'history-entry-return-restored');

    assert.deepEqual(writes, [], 'reading and recovery must not mutate the Program or proposal');
    assert.deepEqual(errors, []);
    return { programId: PROGRAM_ID, selectedStep: option, writes, pageErrors: errors };
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
