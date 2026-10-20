import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  approvalItem,
  assetReview,
  CANDIDATE_VERSION,
  CURRENT_VERSION,
  laterTaskMessage,
  PROGRAM_ID,
  PROPOSAL_ID,
  pendingProjection,
  unifiedAttention,
} from './f311-v2-closure.fixture.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

async function rejectFixtureWrite(route, request, url, writes) {
  const protectedPath =
    url.pathname.startsWith('/api/capability-evolution/programs') ||
    url.pathname.startsWith('/api/eval-repair-proposals');
  if (request.method() === 'GET' || !protectedPath) return false;
  writes.push({ method: request.method(), path: url.pathname });
  await route.fulfill({ status: 405, json: { error: 'isolated_read_only_fixture' } });
  return true;
}

async function fulfillProgramRead({ route, request, url, f314, rawIndex, programPath, projectExploration }) {
  if (request.method() !== 'GET') return false;
  if (url.pathname === '/api/capability-evolution/programs') {
    await route.fulfill({ json: { programs: [f314] } });
    return true;
  }
  if (url.pathname === programPath) {
    await route.fulfill({ json: f314 });
    return true;
  }
  if (url.pathname === `${programPath}/asset-review`) {
    await route.fulfill({ json: assetReview(url, f314) });
    return true;
  }
  if (url.pathname === `${programPath}/preparation-review`) {
    await route.fulfill({
      status: 503,
      json: {
        schemaVersion: 1,
        status: 'unavailable',
        programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
        objectRef: f314.program.objectRef,
        blockers: [{ code: 'isolated_owner_read_unavailable', ownerRef: f314.program.objectRef }],
      },
    });
    return true;
  }
  if (url.pathname !== `${programPath}/exploration`) return false;
  const input = {
    programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
    objectRef: f314.program.objectRef,
  };
  for (const key of ['selectedNodeRef', 'selectedExperimentRef', 'comparisonExperimentRef']) {
    const value = url.searchParams.get(key);
    if (value) input[key] = JSON.parse(value);
  }
  const publication = projectExploration(input, rawIndex, '2026-10-14T18:00:00.000Z');
  assert(publication, 'reviewed F314 index must produce a valid exploration publication');
  await route.fulfill({ json: publication });
  return true;
}

async function fulfillAttentionRead({ route, request, url, item, showLaterMessage }) {
  if (request.method() !== 'GET') return false;
  const bodies = new Map([
    ['/api/approval-hub/pending', { items: [item], count: 1 }],
    ['/api/approval-hub/settled', { items: [], count: 0 }],
    ['/api/concierge/work/decisions', unifiedAttention(item)],
    ['/api/messages', laterTaskMessage(showLaterMessage)],
  ]);
  const body = bodies.get(url.pathname);
  if (!body) return false;
  await route.fulfill({ json: body });
  return true;
}

/** One stateful S6 fixture journey. The candidate is deliberately not owner truth. */
export async function verifyV2ClosureJourney({ fixture, browser, capture }) {
  const snapshots = JSON.parse(
    await readFile(new URL('./fixtures/f311-v2-program-snapshots.json', import.meta.url), 'utf8'),
  );
  const f314 = pendingProjection(snapshots.programs.find((entry) => entry.program.programId === PROGRAM_ID));
  const item = approvalItem();
  const rawIndex = JSON.parse(
    await readFile(
      new URL('../../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
      'utf8',
    ),
  );
  const linkedCase = rawIndex.cases.find((entry) => entry.link && entry.citedMemberCommits.length);
  assert(linkedCase, 'reviewed F314 index must retain a case with an exact cited commit');
  const linkedNarrative = rawIndex.story.cases.find((entry) => entry.caseId === linkedCase.caseId);
  assert(linkedNarrative, 'the linked case must retain one readable story narrative');
  const linkedStep = rawIndex.story.nodes.find((entry) => entry.id === linkedNarrative.nodeId);
  assert(linkedStep, 'the linked case narrative must resolve to one readable story step');
  const linkedStepSource = rawIndex.story.sources.find((entry) => entry.id === linkedStep.changes[0]?.sourceId);
  assert(linkedStepSource, 'the linked story step must retain one exact source');
  const { projectRequestReviewHarnessExploration: projectExploration } = await import(
    '../../../api/src/infrastructure/capability-evolution/adapters/request-review/request-review-harness-lineage.ts'
  );
  const programPath = `/api/capability-evolution/programs/${encodeURIComponent(PROGRAM_ID)}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let showLaterMessage = false;
  const writes = [];
  const errors = [];
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await rejectFixtureWrite(route, request, url, writes)) return;
    if (await fulfillProgramRead({ route, request, url, f314, rawIndex, programPath, projectExploration })) return;
    if (await fulfillAttentionRead({ route, request, url, item, showLaterMessage })) return;
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
    await home.getByText('待判断 1', { exact: true }).waitFor();
    await capture(page, 's6-home-pending');

    await home.getByTestId(`capability-evolution-program-${PROGRAM_ID}`).click();
    let detail = home.getByTestId('capability-evolution-program-detail');
    const adoptionAndCandidates = detail.getByRole('region', { name: '采用与候选' });
    const adoptionText = await adoptionAndCandidates.innerText();
    assert.ok(adoptionText.includes('本项目尚无采用记录。'));
    assert.ok(adoptionText.includes('来源当前版本'));
    assert.ok(adoptionText.includes('当前 request-review 规则'));
    assert.ok(!adoptionText.includes('当前采用\n当前 request-review 规则'));
    assert.ok(!adoptionText.includes('1970-01-01'));
    const journey = detail.getByRole('navigation', { name: '能力进化旅程' });
    await journey.getByRole('button', { name: '准备', exact: true }).click();
    const overview = detail.getByRole('region', { name: '准备四块总览' });
    await overview.waitFor();
    await overview.locator('[data-preparation-overview]').first().click();
    let main = page.locator('[data-testid="evolution-program-surface"]:visible');
    await main.getByTestId('evolution-preparation-workspace').waitFor();
    const chatHost = page.getByTestId('thread-chat-host');
    const workspaceHost = page.getByTestId('contextual-workspace-host');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('data-presentation') ===
        'wide-workspace',
    );
    assert.equal(await workspaceHost.getAttribute('data-presentation'), 'wide-workspace');
    assert.equal(await chatHost.getAttribute('aria-hidden'), null);
    const draft = 'v2 Program 阅读返回仍在原 Chat';
    const composer = chatHost.getByRole('textbox', { name: '消息输入框', exact: true });
    await composer.fill(draft);
    const readingTop = await main.evaluate((element) => {
      element.scrollTop = 140;
      element.dispatchEvent(new Event('scroll'));
      window.__f311V2ReturnProgram = element;
      return element.scrollTop;
    });
    await chatHost.evaluate((element) => {
      window.__f311V2ReturnChat = element;
    });
    assert(readingTop > 0, 'the v2 return contract needs a real reading position');
    await page.locator('summary[aria-label="更多 Workspace 操作"]').click();
    await page.getByRole('menuitemcheckbox', { name: '整窗', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('data-presentation') ===
        'main-area-attention',
    );
    const returnToChat = page.getByTestId('v2-workspace-return-to-chat');
    await returnToChat.waitFor();
    assert.equal(await chatHost.getAttribute('aria-hidden'), 'true');
    await capture(page, 's6-preparation-full-window-return');
    await returnToChat.click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('data-presentation') ===
        'wide-workspace',
    );
    assert.equal(await composer.inputValue(), draft);
    assert.equal(await main.evaluate((element) => element.scrollTop), readingTop);
    assert.equal(
      await main
        .getByTestId('evolution-preparation-workspace')
        .locator('[data-preparation-section="object_map"]')
        .getAttribute('aria-selected'),
      'true',
    );
    assert.equal(await chatHost.evaluate((node) => window.__f311V2ReturnChat === node && node.isConnected), true);
    assert.equal(await main.evaluate((node) => window.__f311V2ReturnProgram === node && node.isConnected), true);
    await page.evaluate(() => {
      delete window.__f311V2ReturnChat;
      delete window.__f311V2ReturnProgram;
    });
    await capture(page, 's6-preparation-main');
    await main.getByRole('button', { name: '← 返回侧栏', exact: true }).click();

    detail = page.locator('[data-testid="capability-evolution-program-detail"]:visible');
    await detail
      .getByRole('navigation', { name: '能力进化旅程' })
      .getByRole('button', { name: '探索进化', exact: true })
      .click();
    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    main = page.locator('[data-testid="evolution-program-surface"]:visible');
    const exploration = main.getByTestId('evolution-exploration-workspace');
    await exploration.waitFor();
    const picker = exploration.getByLabel('选择阅读步骤');
    await picker.waitFor();
    const option = await picker.locator('option', { hasText: linkedStep.title }).getAttribute('value');
    assert(option, 'F314 history fixture must expose the linked case story step');
    await picker.selectOption(option);
    assert.equal(await picker.inputValue(), option);
    const selectedStep = exploration.locator('.exploration-history-step');
    await selectedStep.getByRole('heading', { name: linkedStep.title, exact: true }).waitFor();
    const firstChangeSource = selectedStep.locator('.exploration-history-changes details.evolution-source').first();
    await firstChangeSource.locator(':scope > summary').click();
    const stepLink = firstChangeSource.getByRole('link', { name: '打开来源' });
    assert.equal(
      await stepLink.getAttribute('href'),
      `https://github.com/zts212653/clowder-ai/blob/${rawIndex.snapshotCommit}/${linkedStepSource.path}`,
    );

    const selectedCase = exploration.locator('.exploration-history-case-toggle', {
      hasText: linkedNarrative.title ?? linkedNarrative.problem,
    });
    await selectedCase.waitFor();
    if ((await selectedCase.getAttribute('aria-expanded')) !== 'true') await selectedCase.click();
    const caseBody = selectedCase.locator('xpath=following-sibling::*[1]');
    await caseBody.waitFor();
    const originalSources = caseBody.getByText('历史原件与后续来源', { exact: true }).locator('..');
    await originalSources.locator(':scope > summary').click();
    const caseSource = originalSources.locator('details.evolution-source', { hasText: '案例原文' });
    await caseSource.locator(':scope > summary').click();
    const caseLink = caseSource.getByRole('link', { name: '打开来源' });
    assert.ok((await caseLink.getAttribute('href')).includes(linkedCase.link.split('#')[0]));
    const citedCommitSource = originalSources.locator('details.evolution-source', { hasText: '原文引用' }).first();
    await citedCommitSource.locator(':scope > summary').click();
    const citedCommitLink = citedCommitSource.getByRole('link', { name: '打开来源' });
    assert.equal(
      await citedCommitLink.getAttribute('href'),
      `https://github.com/zts212653/clowder-ai/commit/${linkedCase.citedMemberCommits[0].fullSha}`,
    );
    await capture(page, 's6-exploration-selection');
    await main.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
    await page
      .locator('[data-testid="capability-evolution-program-detail"]:visible')
      .getByRole('button', { name: '在主区展开阅读' })
      .click();
    main = page.locator('[data-testid="evolution-program-surface"]:visible');
    await main.getByTestId('evolution-exploration-workspace').waitFor();
    assert.equal(
      await main.getByLabel('选择阅读步骤').inputValue(),
      option,
      'return must restore exact archive reading',
    );
    await main.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
    await page
      .locator('[data-testid="capability-evolution-program-detail"]:visible')
      .getByRole('button', { name: '← 全部项目' })
      .click();

    await home.getByRole('button', { name: '去待办审阅', exact: true }).click();
    const explanation = page.getByTestId('eval-repair-decision-explanation');
    await explanation.waitFor();
    const decisionText = await explanation.innerText();
    for (const text of [
      '这次只批准一件事',
      '让后续审阅结果显示它实际沿用的规则版本',
      '后续结果显示 exact version，并从原项目进入治理操作',
      '只证明当前任务使用了该版本；不证明候选已获批准或整体交付改善',
      '隔离旅程核对真实入口、状态恢复和零 Program 写入',
      '从回复文案推断版本',
      '来源行可移除；回退动作仍由 Program owner 执行',
      'exact target、owner 或授权变化时撤回',
    ])
      assert.ok(decisionText.includes(text), `Mailbox candidate detail is missing: ${text}`);
    await explanation.getByText('目标版本', { exact: true }).click();
    await explanation.getByText(CANDIDATE_VERSION.version, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('approve-btn').count(), 1);
    assert.equal(await page.getByTestId('reject-btn').count(), 1);
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-testid="mailbox-panel"]');
      return panel instanceof HTMLElement && getComputedStyle(panel).opacity === '1';
    });
    await capture(page, 's6-mailbox-candidate-fixture');
    assert.equal(f314.lineage.current.status, 'pending');
    assert.ok(!f314.program.currentAssetVersionRefs.some((ref) => ref.version === CANDIDATE_VERSION.version));

    showLaterMessage = true;
    await page.getByTestId('mailbox-close').click();
    await page.reload();
    let source = page.locator('[data-testid="evolution-use-source"]:visible');
    await source.waitFor();
    assert.ok((await source.innerText()).includes('已沿用上次确认的规则'));
    const sourceLink = source.getByTestId('evolution-use-source-open');
    assert.ok((await sourceLink.getAttribute('href')).includes(CURRENT_VERSION.version));
    assert.ok(!(await sourceLink.getAttribute('href')).includes(CANDIDATE_VERSION.version));
    await capture(page, 's6-chat-use-source');
    await sourceLink.click();
    main = page.locator('[data-testid="evolution-program-surface"]:visible');
    await main.waitFor();
    assert.equal(await main.getAttribute('data-reading-view'), 'history');

    await page.reload();
    source = page.locator('[data-testid="evolution-use-source"]:visible');
    await source.waitFor();
    await source.getByTestId('evolution-use-source-rollback').click();
    await page.waitForFunction(() => {
      const visible = [...document.querySelectorAll('[data-testid="evolution-program-surface"]')].find(
        (element) => element.getClientRects().length,
      );
      return visible?.getAttribute('data-reading-view') === 'judgment';
    });
    assert.deepEqual(writes, [], 'source and rollback entries must not mutate the Program or candidate');
    assert.deepEqual(errors, []);
    return {
      programId: PROGRAM_ID,
      pendingProposalId: PROPOSAL_ID,
      archiveSelection: option,
      currentSourceVersion: CURRENT_VERSION.version,
      candidateVersion: CANDIDATE_VERSION.version,
      writes,
      pageErrors: errors,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'f311-v2-closure-failure',
        url: page.url(),
        body: await page
          .locator('body')
          .innerText()
          .catch(() => ''),
        writes,
        errors,
      }),
    );
    await capture(page, 's6-closure-failure');
    throw error;
  } finally {
    await context.close();
  }
}
