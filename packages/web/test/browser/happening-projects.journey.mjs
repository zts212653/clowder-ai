import assert from 'node:assert/strict';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

/** Real /thread and Home UI; controlled execution truth, with no live cancellation. */
export async function runHappeningProjectsJourney({ browser, baseUrl, threadId, fixtureForApi, viewport, language }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const cats = [
    ['codex61-sol', '小太阳·砚砚', 'GPT-6.1 Sol'],
    ['codex-astra', '小星星·砚砚', 'GPT-6 Astra'],
    ['opus55', '宪宪', 'Opus 5.5'],
  ];
  const titles = [
    [threadId, 'Happening Now 跨项目修复', '/project/cat-cafe'],
    ['planet-tripo', 'F329 猫猫星球·② Tripo 线：猫、人和近景素材', '/project/cat-planet'],
    ['planet-sandbox', 'F329 猫猫星球·① 沙盘线：OSM 选址与可走沙盘', '/project/cat-planet'],
    ['planet-world', 'F329 猫猫星球·③ 世界线：能走、能联机、能进门', '/project/cat-planet'],
    ['unassigned', '未归项目的工作', 'default'],
  ];
  const threads = titles.map(([id, title, projectPath]) => ({
    id,
    title,
    projectPath,
    createdBy: 'f295-parallel-user',
    createdAt: 1,
    lastActiveAt: 1,
    participants: cats.map(([catId]) => catId),
  }));
  const makeRun = (id, catId, executionId, age) => {
    const thread = threads.find((t) => t.id === id);
    return {
      kind: 'live_invocation',
      executionId,
      turnInvocationId: `child-${executionId}`,
      threadId: id,
      threadTitle: thread.title,
      projectPath: thread.projectPath,
      catId,
      startedAt: Date.now() - age,
      cancelability: { state: 'cancelable', target: { kind: 'live_invocation', threadId: id, catId, executionId } },
    };
  };
  let executions = [
    makeRun(threadId, 'codex61-sol', 'cafe', 30_000),
    makeRun('planet-tripo', 'codex61-sol', 'tripo', 1_200_000),
    makeRun('planet-sandbox', 'codex-astra', 'sandbox-a', 900_000),
    makeRun('planet-sandbox', 'opus55', 'sandbox-b', 600_000),
    makeRun('planet-world', 'codex-astra', 'world', 300_000),
    makeRun('unassigned', 'opus55', 'unassigned', 60_000),
  ];
  let unavailableProjectPaths = [];
  const collapsed = {};
  const foldSections = { live: collapsed, waiting: {}, deployment: {} };
  const waitItem = (id, thread, state = 'waiting_for_update') => ({
    taskId: id,
    threadId: thread,
    projectPath: threads.find((t) => t.id === thread).projectPath,
    threadTitle: threads.find((t) => t.id === thread).title,
    taskTitle: `验收 ${id}`,
    ownerCatId: 'codex61-sol',
    subjectRef: 'deployment:alpha:runtime',
    deploymentId: 'runtime',
    generation: 1,
    createdAt: Date.now() - 23 * 3600000,
    nextStep: '在原对话核实交付结果',
    condition: { kind: 'revision_included', revision: 'a'.repeat(40), services: ['api', 'web'] },
    state,
  });
  let waits = [waitItem('update-one', threadId), waitItem('update-two', threadId)];
  const cancellations = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((language) => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', language);
    localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
  }, language);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/debug/callback-auth')
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forbidden' }),
      });
    let body;
    if (url.pathname === '/api/executions/active') {
      assert.equal(url.search, '?scope=all');
      body = { scope: 'all', executions, unavailableProjectPaths };
    } else if (url.pathname === '/api/config/live-projects') {
      const section = foldSections[url.searchParams.get('section') ?? 'live'];
      if (request.method() === 'PUT') {
        const patch = request.postDataJSON();
        section[patch.projectPath] = patch.collapsed;
      }
      body = { collapsed: section };
    } else if (url.pathname === '/api/runtime-deployment/waits') {
      assert.equal(url.search, '?scope=all');
      body = {
        scope: 'all',
        projectPath: null,
        items: waits,
        candidate: {
          revision: 'b'.repeat(40),
          observedAt: Date.now(),
          satisfiableCount: waits.filter((item) => item.state === 'waiting_for_update').length,
          unknownCount: waits.filter((item) => item.state === 'unknown').length,
        },
      };
    } else if (url.pathname.endsWith('/sessions')) {
      body = {
        sessions: [
          { id: 'session-seven', catId: 'codex61-sol', seq: 7, status: 'active', messageCount: 20, createdAt: 1 },
        ],
      };
    } else if (url.pathname.includes('/executions/live/') && url.pathname.endsWith('/cancel')) {
      const catId = request.postDataJSON().catId;
      cancellations.push([url.pathname, catId]);
      executions = executions.filter(
        (run) => !(url.pathname.includes(`/live/${run.executionId}/`) && run.catId === catId),
      );
      body = { ok: true, cancelled: true };
    } else if (url.pathname === '/api/threads') body = { threads };
    else if (threads.some((t) => url.pathname === `/api/threads/${t.id}`))
      body = threads.find((t) => url.pathname === `/api/threads/${t.id}`);
    else if (url.pathname === '/api/cats')
      body = {
        cats: cats.map(([id, nickname, variantLabel]) => ({
          id,
          nickname,
          variantLabel,
          displayName: nickname,
          avatar: `/avatars/family/${id}.png`,
          roster: { available: true },
          carrier: 'cli',
          clientId: 'openai',
          defaultModel: variantLabel,
          mentionPatterns: [`@${id}`],
          color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
        })),
      };
    else body = fixtureForApi(url);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    const home = page.getByTestId('workspace-developing');
    const planet = home.locator('[data-project-path="/project/cat-planet"]');
    const heading = planet.locator('button[aria-expanded]');
    await planet.waitFor();
    assert.equal(await planet.getByTestId('workspace-running-object').count(), 4);
    assert.equal(await heading.getAttribute('aria-expanded'), 'true');
    assert.equal(
      await home.getByTestId('home-live-project').first().getAttribute('data-project-path'),
      '/project/cat-cafe',
    );
    await home.getByText(language === 'en' ? 'Uncategorized' : '未分类', { exact: true }).waitFor();
    await page.screenshot({ path: `/tmp/happening-projects-expanded-${viewport.width}-${language}.png` });
    await page.waitForFunction(
      () => !document.querySelector('[data-project-path="/project/cat-planet"] button')?.disabled,
    );
    await heading.focus();
    await heading.press('Space');
    await heading.locator('..').locator('[hidden]').waitFor({ state: 'attached' });
    assert.equal(collapsed['/project/cat-planet'], true);
    assert.match(await heading.innerText(), language === 'en' ? /4 running.*longest/ : /4 件在跑.*最长/);
    executions.push(makeRun('planet-world', 'opus55', 'new-world', 1));
    await page.waitForFunction(() =>
      document.querySelector('[data-project-path="/project/cat-planet"] button')?.textContent.includes('5'),
    );
    assert.equal(await heading.getAttribute('aria-expanded'), 'false', 'new work must not reopen a collapsed group');
    await page.screenshot({ path: `/tmp/happening-projects-collapsed-${viewport.width}-${language}.png` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await planet.waitFor();
    await heading.filter({ hasText: language === 'en' ? /5 running/ : /5 件在跑/ }).waitFor();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false', 'saved preference must survive reload');
    await heading.press('Enter');
    await planet.locator('[data-execution-id="tripo"] a').click();
    await page.waitForURL('**/thread/planet-tripo');
    await ensureWorkspaceOpen(page);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="home-live-project"]')?.getAttribute('data-project-path') ===
        '/project/cat-planet',
    );
    await heading.click();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
    const currentFoldFits = await heading.evaluate((button) => button.scrollWidth <= button.clientWidth + 1);
    assert.ok(currentFoldFits, 'the collapsed current-project heading must fit too');
    assert.ok(
      (await heading.locator('.home-project-name').boundingBox()).width >= 30,
      'project identity must remain readable beside the current-project marker and timer',
    );
    assert.ok(
      await heading.locator('.home-project-name').evaluate((name) => name.scrollWidth <= name.clientWidth + 1),
      'the ordinary project name stays complete before the optional current-project tag',
    );
    await page.screenshot({ path: `/tmp/happening-current-project-fold-${viewport.width}-${language}.png` });
    await heading.click();
    const tripo = planet.locator('[data-execution-id="tripo"]');
    await tripo.getByRole('button', { name: /停止|Stop/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: language === 'en' ? 'Stop' : '停止', exact: true })
      .click();
    await tripo.waitFor({ state: 'detached' });
    assert.deepEqual(cancellations, [['/api/threads/planet-tripo/executions/live/tripo/cancel', 'codex61-sol']]);
    assert.ok(executions.some((run) => run.executionId === 'cafe'));
    unavailableProjectPaths = ['/project/cat-planet'];
    executions = executions.filter((run) => run.projectPath !== '/project/cat-planet');
    await planet
      .getByText(
        language === 'en' ? "Can't read run status for this project right now" : '这个项目的运行情况暂时读不到',
      )
      .waitFor();
    assert.equal(
      await planet.getByTestId('workspace-running-object').count(),
      0,
      'failed project must not reuse old running rows',
    );
    const notice = await planet.locator('.home-project-unavailable').evaluate((node) => {
      const sample = document.createElement('span');
      sample.style.color = 'var(--shell-body)';
      node.append(sample);
      const body = getComputedStyle(sample).color;
      sample.remove();
      const dot = getComputedStyle(node, '::before');
      return { color: getComputedStyle(node).color, body, dotWidth: dot.width, dotHeight: dot.height };
    });
    assert.equal(notice.color, notice.body, 'unavailable status uses neutral body text');
    assert.deepEqual([notice.dotWidth, notice.dotHeight], ['8px', '8px']);
    assert.equal(await home.locator('[data-execution-id="cafe"]').count(), 1);
    const waiting = page.getByTestId('workspace-deployment-waits');
    const deploymentFold = waiting.locator('[data-project-path="/project/cat-cafe"] .home-project-head');
    assert.equal(await waiting.getByTestId('home-deployment-fold').count(), 0, 'pure updates use the project fold');
    assert.equal(await deploymentFold.getAttribute('aria-expanded'), 'false');
    assert.equal(await waiting.getByTestId('workspace-deployment-wait-item').filter({ visible: true }).count(), 0);
    await deploymentFold.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `/tmp/happening-home-updates-${viewport.width}-${language}.png` });
    await deploymentFold.focus();
    await deploymentFold.press('Enter');
    assert.equal(await waiting.getByTestId('workspace-deployment-wait-item').filter({ visible: true }).count(), 2);
    assert.equal(foldSections.deployment['/project/cat-cafe'], false);
    const disclosure = waiting.getByRole('button', { name: language === 'en' ? 'After resuming' : '接回后' }).first();
    await disclosure.click();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.ok((await waiting.innerText()).includes('在原对话核实交付结果'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await waiting.waitFor();
    await deploymentFold.locator('..').locator('button[aria-expanded="true"]').waitFor();
    assert.equal(await deploymentFold.getAttribute('aria-expanded'), 'true');
    waits = [
      ...waits,
      waitItem('condition-unconfirmed', 'planet-world', 'unknown'),
      waitItem('planet-update', 'planet-world'),
    ];
    await waiting.locator('[data-project-path="/project/cat-planet"] [data-state="unknown"]').waitFor();
    const unknown = waiting.locator('[data-state="unknown"]');
    assert.equal(await unknown.isVisible(), true, 'other wait states must remain individually visible');
    assert.equal(await unknown.locator('.home-wait-details').isVisible(), false);
    assert.equal(await waiting.locator('.home-btn').count(), 0, 'wait rows have no outlined conversation buttons');
    const cafeWaits = waiting.locator('[data-project-path="/project/cat-cafe"]');
    assert.equal(await cafeWaits.locator('.home-project-head').count(), 1);
    assert.equal(
      await cafeWaits.locator('.home-deployment-fold').count(),
      0,
      'update-only projects have one disclosure',
    );
    assert.equal(
      await waiting.locator('[data-project-path="/project/cat-planet"] .home-deployment-fold').count(),
      1,
      'mixed projects keep the separate update-only summary',
    );
    assert.equal(await page.getByTestId('home-conversation-scope').count(), 1);
    assert.equal(await page.locator('#home-status-title').locator('..').locator('svg').count(), 1);
    assert.equal(await page.locator('#home-works-title').locator('..').locator('svg').count(), 1);
    if (viewport.width < 600) await heading.click();
    else await cafeWaits.locator('.home-project-head').click();
    await unknown.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `/tmp/happening-home-mixed-${viewport.width}-${language}.png` });
    const waitFits = await waiting
      .locator('.home-project-head')
      .evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth + 1));
    assert.ok(waitFits, 'waiting project headers must fit the panel');
    if (language === 'en')
      assert.ok(
        !(await waiting.locator('.home-project-head').allTextContents()).some((text) => text.includes('running')),
        'waiting projects are not running executions',
      );
    const fits = await home
      .locator('.home-project-head')
      .evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth + 1));
    assert.ok(fits, 'project headers must stay within the panel');
    const metadataFits = await page.locator('.home-live-heading').evaluateAll((rows) =>
      rows.every((row) => {
        const rect = row.getBoundingClientRect();
        if (!rect.width) return true;
        const children = [...row.children].map((child) => child.getBoundingClientRect());
        return (
          rect.height <= Math.max(...children.map((child) => child.height)) + 1 &&
          children.every((child) => child.left >= rect.left - 1 && child.right <= rect.right + 1)
        );
      }),
    );
    assert.ok(metadataFits, 'names yield space so state and duration stay on the first line in all Home rows');
    assert.ok(
      await home
        .locator('.home-project-chevron')
        .evaluateAll((icons) =>
          icons.every(
            (icon) => icon.tagName.toLowerCase() === 'svg' && Math.abs(icon.getBoundingClientRect().width - 12) < 1,
          ),
        ),
      'project and update disclosures use the sidebar-sized chevron',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: `/tmp/happening-projects-failure-${viewport.width}-${language}.png` });
    console.error((await page.locator('body').innerText()).slice(-5000));
    throw error;
  } finally {
    await context.close();
  }
}
