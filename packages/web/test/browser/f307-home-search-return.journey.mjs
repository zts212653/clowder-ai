import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  activeExecutionFixture,
  canonicalWorktreeId,
  realSurfaceApiResponse,
  THREAD_ID,
  WORKTREE_ID,
} from './f307-real-surface-fixtures.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

function searchGeometry() {
  const home =
    document.documentElement.dataset.shell === 'v2'
      ? document.querySelector('[data-v2-workspace-menu]:not([hidden])')
      : document.querySelector('[data-testid="f307-workspace-home-page"]');
  const input = home?.querySelector('[data-testid="workspace-launcher-search"]');
  const result = home?.querySelector('[data-testid="workspace-launcher-file-result"]');
  if (!home || !input || !result) return null;
  const h = home.getBoundingClientRect();
  const i = input.getBoundingClientRect();
  const r = result.getBoundingClientRect();
  const visible = (rect) =>
    rect.width > 0 && rect.top >= Math.max(0, h.top) - 1 && rect.bottom <= Math.min(innerHeight, h.bottom) + 1;
  return {
    query: input.value,
    offset: i.top - h.top,
    scrollTop: home.scrollTop,
    inputVisible: visible(i),
    resultVisible: visible(r),
    windowY: scrollY,
    clientHeight: home.clientHeight,
    inputHeight: i.height,
    liveRows: home.querySelectorAll('[data-testid="workspace-running-object"]').length,
  };
}

function returnedSearchIsVisible(expectedOffset) {
  const home =
    document.documentElement.dataset.shell === 'v2'
      ? document.querySelector('[data-v2-workspace-menu]:not([hidden])')
      : document.querySelector('[data-testid="f307-workspace-home-page"]');
  const input = home?.querySelector('[data-testid="workspace-launcher-search"]');
  const result = home?.querySelector('[data-testid="workspace-launcher-file-result"]');
  if (!home || !input || !result) return false;
  const h = home.getBoundingClientRect();
  const i = input.getBoundingClientRect();
  const r = result.getBoundingClientRect();
  return (
    input.value === 'DESIGN.md' &&
    i.top >= Math.max(0, h.top) - 1 &&
    r.bottom <= Math.min(innerHeight, h.bottom) + 1 &&
    Math.abs(i.top - h.top - Math.min(expectedOffset, home.clientHeight - i.height)) <= 2
  );
}

function answerHomeSearch(route) {
  const request = route.request();
  const url = new URL(request.url());
  let response = realSurfaceApiResponse(request, false);
  if (url.pathname === '/api/executions/active') {
    const fixture = activeExecutionFixture(true);
    response = {
      body: {
        ...fixture,
        executions: Array.from({ length: 18 }, (_, index) => ({
          ...fixture.executions[0],
          executionId: `home-return-execution-${index}`,
          threadId: `home-return-thread-${index}`,
          threadTitle: `Ongoing work ${index}`,
        })),
      },
    };
  }
  if (url.pathname === '/api/workspace/search')
    response = {
      body: {
        results: [
          {
            path: 'DESIGN.md',
            line: 0,
            content: 'F307 Composable Workbench',
            contextBefore: '',
            contextAfter: '',
            matchType: 'filename',
          },
        ],
      },
    };
  return route.fulfill({
    status: response.status ?? 200,
    contentType: 'application/json',
    body: JSON.stringify(response.body),
  });
}

function recordSearchSource() {
  document.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('[data-testid="workspace-launcher-file-result"]')) return;
      const home =
        document.documentElement.dataset.shell === 'v2'
          ? document.querySelector('[data-v2-workspace-menu]:not([hidden])')
          : document.querySelector('[data-testid="f307-workspace-home-page"]');
      const input = home.querySelector('[data-testid="workspace-launcher-search"]');
      window.__homeSearchSource = {
        query: input.value,
        offset: input.getBoundingClientRect().top - home.getBoundingClientRect().top,
        url: location.href,
      };
    },
    { capture: true },
  );
}

async function activateControl(control, inputMode) {
  if (inputMode === 'mouse') await control.click();
  else await control.press('Enter');
}

function tracePinInput() {
  const host = document.querySelector('[data-testid="f307-experience-workbench"]');
  const records = [];
  const snapshot = (kind, event) => {
    if (records.length >= 64) return;
    records.push({
      kind,
      at: performance.now(),
      trusted: event?.isTrusted ?? null,
      key: event?.key ?? null,
      target: event?.target?.getAttribute?.('aria-label') ?? null,
      targetConnected: event?.target?.isConnected ?? null,
      focused: document.activeElement?.getAttribute('aria-label') ?? null,
      activeSurfaceId: host?.getAttribute('data-active-surface'),
      pinnedIds: host?.getAttribute('data-pinned-surfaces'),
    });
  };
  const record = (event) => {
    if (host?.contains(event.target) || event.type === 'keydown' || event.type === 'keyup') snapshot(event.type, event);
  };
  const types = ['focusin', 'keydown', 'keyup', 'click'];
  for (const type of types) document.addEventListener(type, record, true);
  const observer = new MutationObserver(() => snapshot('owner-update'));
  if (host) observer.observe(host, { attributes: true, childList: true, subtree: true });
  window.__finishHomePinTrace = () => {
    observer.disconnect();
    for (const type of types) document.removeEventListener(type, record, true);
    snapshot('finished');
    return records;
  };
  snapshot('started');
}

async function runSearchReturnCase(
  { browser, baseUrl, evidenceDir },
  presentation,
  inputMode,
  pinResolutionProbe = false,
) {
  const width = inputMode === 'mouse' ? 1440 : 390;
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const errors = [];
  const stylesheets = [];
  const deferredRoots = [];
  let releaseRootStarted;
  const rootStarted = new Promise((resolve) => {
    releaseRootStarted = resolve;
  });
  let delayReturnWaits = false;
  const deferredWaits = [];
  const searchRequests = [];
  let delayToolsSearch = false;
  const deferredSearches = [];
  let beforeLateWait;
  await context.addInitScript((mode) => {
    if (window.top !== window || sessionStorage.getItem('f307-search-return-initialized') === '1') return;
    sessionStorage.setItem('f307-search-return-initialized', '1');
    localStorage.clear();
    localStorage.setItem('cat-cafe:shell-presentation', mode);
  }, presentation);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.request().resourceType() === 'stylesheet')
      stylesheets.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.route('**/api/**', async (route) => {
    if (pinResolutionProbe && new URL(route.request().url()).pathname === '/api/workspace/resolve-file-source') {
      releaseRootStarted();
      await new Promise((resolve) => deferredRoots.push(resolve));
    }
    if (new URL(route.request().url()).pathname === '/api/workspace/search') {
      searchRequests.push(route.request().postDataJSON());
      if (delayToolsSearch) await new Promise((resolve) => deferredSearches.push(resolve));
    }
    if (delayReturnWaits && new URL(route.request().url()).pathname === '/api/runtime-deployment/waits') {
      await new Promise((resolve) => deferredWaits.push(resolve));
    }
    return answerHomeSearch(route);
  });
  const name = `home-return-${presentation}-${inputMode}-${width}${pinResolutionProbe ? '-focused-resolution' : ''}`;
  try {
    await page.goto(baseUrl);
    await ensureWorkspaceOpen(page);
    if (presentation === 'v2') await page.waitForFunction(() => document.documentElement.dataset.shell === 'v2');
    const home = page.getByTestId('f307-workspace-home-page');
    await home.waitFor({ state: 'visible' });
    if (presentation === 'v2')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="workspace-running-object"]').length === 18,
      );
    if (presentation === 'v2') await activateControl(page.getByTestId('v2-workspace-tools'), inputMode);
    const searchOwner = presentation === 'v2' ? page.locator('[data-v2-workspace-menu]:not([hidden])') : home;
    const input = searchOwner.getByTestId('workspace-launcher-search');
    await input.fill('DESIGN.md');
    const result = searchOwner.getByTestId('workspace-launcher-file-result').first();
    await result.waitFor({ state: 'visible' });
    await page.evaluate(recordSearchSource);
    if (inputMode === 'mouse') await result.click();
    else {
      await input.press('Tab');
      assert.ok(await result.evaluate((element) => element === document.activeElement));
      await result.press('Enter');
    }
    const source = await page.evaluate(() => window.__homeSearchSource);
    assert.equal(source.query, 'DESIGN.md');
    const workbench = page.getByTestId('f307-experience-workbench');
    const tab = page
      .getByTestId('f307-tab-strip')
      .locator('[data-tab-surface-id]')
      .filter({ has: page.getByRole('tab', { name: 'DESIGN.md', exact: true }) });
    const openedSurfaceId = await tab.getAttribute('data-tab-surface-id');
    assert.ok(openedSurfaceId, 'the opened document has its surface identity');
    const pin = tab.getByRole('button', { name: '固定 DESIGN.md', exact: true });
    await page.evaluate(tracePinInput);
    try {
      if (pinResolutionProbe) {
        // The real owner resolves its alias between two physical user steps.
        // This must not discard the focused Pin control before Enter arrives.
        await rootStarted;
        await pin.focus();
        assert.ok(await pin.evaluate((element) => document.activeElement === element));
        for (const release of deferredRoots.splice(0)) release();
        await page.waitForFunction(
          (id) =>
            document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-active-surface') !==
            id,
          openedSurfaceId,
        );
        await page.keyboard.press('Enter');
        assert.ok(
          await tab.getByRole('button', { name: '取消固定 DESIGN.md', exact: true }).isVisible(),
          'canonical resolution must retain focused Pin and accept the physical Enter',
        );
      } else await activateControl(pin, inputMode);
      await tab.getByRole('button', { name: '取消固定 DESIGN.md', exact: true }).waitFor({ state: 'visible' });
    } finally {
      const trace = await page.evaluate(() => window.__finishHomePinTrace());
      await writeFile(path.join(evidenceDir, `${name}-pin-trace.json`), `${JSON.stringify(trace, null, 2)}\n`);
    }
    // F309 now supplies the original file reader and quote controls on the same
    // page; there is no separate Markdown file-tools owner to enter.
    await workbench
      .getByTestId('workspace-file-viewer')
      .getByRole('heading', { name: 'F307 Composable Workbench', exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(await workbench.getByTestId('workspace-file-viewer').count(), 1);
    // The source resolver may replace an alias descriptor with its canonical
    // document identity. Preserve the pin on that same named loaded document.
    const surfaceId = await tab.getAttribute('data-tab-surface-id');
    assert.ok(surfaceId);
    assert.ok(
      (await workbench.getAttribute('data-pinned-surfaces')).split(',').includes(surfaceId),
      'the loaded document remains pinned before its named return',
    );
    const identity = { openedSurfaceId, loadedSurfaceId: surfaceId };
    if (presentation === 'v2' && inputMode === 'mouse') {
      // The actual opened origin, pin and owner must survive persisted reload before Back.
      await page.reload();
      await workbench.getByRole('button', { name: '‹ 工具搜索', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await workbench.getAttribute('data-active-surface'), surfaceId);
    }
    // Both shells return through the same mounted file reader. Classic retains
    // its existing source action; v2 names the actual tools-popup origin.
    const back =
      presentation === 'v2'
        ? inputMode === 'mouse'
          ? workbench.getByRole('button', { name: '‹ 工具搜索', exact: true })
          : page.getByTestId('v2-file-back')
        : workbench.getByRole('button', { name: '返回来源', exact: true });
    await back.waitFor({ state: 'visible' });
    if (presentation === 'classic') delayReturnWaits = true;
    await activateControl(back, inputMode);
    await input.waitFor({ state: 'visible' });
    await result.waitFor({ state: 'visible' });
    await page.waitForFunction(returnedSearchIsVisible, source.offset, { timeout: 5000 });
    if (presentation === 'classic') {
      // Real hook/data timing: Home remount inserts a loading section after the observer's first layout effect.
      // Only after search/results have settled do we release the existing readonly wait response. Its ready
      // section grows independently of the scroller and old sibling boxes; native ResizeObserver must cover it.
      await home.getByTestId('workspace-deployment-waits').filter({ hasText: '正在读取等待更新的事项' }).waitFor();
      assert.ok(deferredWaits.length > 0, 'the original deployment hook has a genuinely pending response');
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      beforeLateWait = await page.evaluate(searchGeometry);
      delayReturnWaits = false;
      for (const release of deferredWaits.splice(0)) release();
      await home.getByText('暂无待跟进事项', { exact: true }).waitFor();
      await page.waitForFunction(returnedSearchIsVisible, source.offset, { timeout: 5000 });
    }
    if (presentation === 'v2') {
      assert.equal(searchRequests.length, 4, 'source and Back each issue the original filename/content pair once');
      assert.deepEqual(searchRequests.map((request) => request.type).sort(), [
        'content',
        'content',
        'filename',
        'filename',
      ]);
      assert.ok(searchRequests.every((request) => request.query === 'DESIGN.md'));
      await input.press('Escape');
      const trigger = page.getByTestId('v2-workspace-tools');
      assert.ok(await trigger.evaluate((element) => element === document.activeElement));
      delayToolsSearch = true;
      await activateControl(back, inputMode);
      await page.waitForFunction(() => !!document.querySelector('[data-v2-workspace-menu]:not([hidden])'));
      // Wait for the actual intercepted query, then close before its readonly result arrives.
      for (let attempt = 0; deferredSearches.length < 2 && attempt < 50; attempt++) await page.waitForTimeout(50);
      assert.equal(deferredSearches.length, 2, 'same-query Back starts the original fresh filename/content pair once');
      await input.press('Escape');
      delayToolsSearch = false;
      for (const release of deferredSearches.splice(0)) release();
      await page.waitForFunction(() => !document.querySelector('[data-v2-workspace-menu]:not([hidden])'));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(
        await page.locator('[data-v2-workspace-menu]:not([hidden])').count(),
        0,
        'late response cannot reopen a dismissed return',
      );
      await activateControl(back, inputMode);
      await result.waitFor({ state: 'visible' });
      await page.waitForFunction(returnedSearchIsVisible, source.offset);
      assert.equal(searchRequests.length, 8, 'each same-query Back has exactly one new original-owner search pair');
    }
    const geometry = await page.evaluate(searchGeometry);
    assert.equal(geometry.query, 'DESIGN.md');
    assert.ok(geometry.inputVisible && geometry.resultVisible, JSON.stringify(geometry));
    assert.ok(
      Math.abs(geometry.offset - Math.min(source.offset, geometry.clientHeight - geometry.inputHeight)) <= 2,
      `source search position was lost: ${JSON.stringify({ source, geometry })}`,
    );
    assert.equal(page.url(), source.url);
    assert.ok(
      (await workbench.getAttribute('data-pinned-surfaces')).split(',').includes(surfaceId),
      'returning to the actual search preserves the document in the original layout owner',
    );
    if (presentation === 'v2') {
      assert.equal(
        await workbench.getAttribute('data-active-surface'),
        surfaceId,
        'tools Back keeps the loaded owner active',
      );
      assert.equal(await home.count(), 0, 'tools search does not replace Home with a synthetic search page');
    }
    assert.ok(await input.evaluate((element) => element === document.activeElement));
    await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
    await writeFile(
      path.join(evidenceDir, `${name}.json`),
      JSON.stringify({ source, identity, beforeLateWait, geometry, searchRequests, errors, stylesheets }, null, 2),
    );
    assert.deepEqual(errors, []);
    assert.ok(
      stylesheets.length > 0 && stylesheets.every((stylesheet) => stylesheet.status === 200),
      JSON.stringify(stylesheets),
    );
  } catch (error) {
    await page.screenshot({ path: path.join(evidenceDir, `${name}-failed.png`) }).catch(() => undefined);
    const geometry = await page.evaluate(searchGeometry).catch(() => null);
    await writeFile(
      path.join(evidenceDir, `${name}-failed.json`),
      JSON.stringify({ beforeLateWait, geometry, errors, stylesheets, failure: String(error) }, null, 2),
    );
    throw error;
  } finally {
    delayReturnWaits = false;
    delayToolsSearch = false;
    for (const release of deferredWaits.splice(0)) release();
    for (const release of deferredSearches.splice(0)) release();
    for (const release of deferredRoots.splice(0)) release();
    await context.close();
  }
}

/** Real Home, Panel stamp, file descriptor, renderer, pin and named return; only API data is isolated. */
export function registerHomeSearchReturnJourneys(getSuite) {
  for (const presentation of ['classic', 'v2']) {
    test(
      `${presentation}: canonical file resolution between focused Pin and physical Enter preserves keyboard activation`,
      { timeout: 90_000 },
      () => runSearchReturnCase(getSuite(), presentation, 'keyboard', true),
    );
  }
  for (const presentation of ['classic', 'v2']) {
    for (const inputMode of ['mouse', 'keyboard']) {
      test(
        `Actual ${presentation === 'v2' ? 'tools popup' : 'Home'} search returns its visible source position in ${presentation} with ${inputMode}`,
        { timeout: 90_000 },
        () => runSearchReturnCase(getSuite(), presentation, inputMode),
      );
    }
  }
  for (const width of [1440, 390]) {
    for (const kind of ['file', 'publication-unavailable']) {
      test(
        `Home works returns the exact ${kind} card through the original owner at ${width}px`,
        { timeout: 90_000 },
        () => runHomeWorksReturnCase(getSuite(), width, kind),
      );
    }
  }
}

/** The publication case exercises the real unavailable landing; it never claims a prepared publication or content approval. */
async function runHomeWorksReturnCase({ browser, baseUrl, evidenceDir }, width, kind) {
  const publication = kind === 'publication-unavailable';
  const chosen = {
    type: publication ? 'image' : 'file',
    name: publication ? 'home-publication.png' : 'home-source.md',
    catId: 'codex-sol',
    createdAt: 1787831702000,
    sourceMessageId: publication ? 'home-publication-message' : null,
    ...(publication
      ? { url: '/uploads/home-publication.png', publicationItem: { kind: 'content-block', index: 1 } }
      : { ref: '/project/cat-cafe/home-source.md' }),
  };
  const companion = (name) => ({
    type: 'code',
    name,
    catId: 'codex-sol',
    createdAt: chosen.createdAt + 1,
    sourceMessageId: null,
  });
  const initial = [companion('first.txt'), companion('second.txt'), chosen];
  const image = publication
    ? await readFile(new URL('../../../../assets/avatars/antig-opus.png', import.meta.url))
    : null;
  let returning = false;
  const requests = [];
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    if (window.top !== window || sessionStorage.getItem('f307-works-return-initialized') === '1') return;
    sessionStorage.setItem('f307-works-return-initialized', '1');
    localStorage.clear();
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (image)
    await page.route('**/uploads/home-publication.png', (route) =>
      route.fulfill({ contentType: 'image/png', body: image }),
    );
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let response = realSurfaceApiResponse(request, false);
    if (url.pathname === `/api/threads/${THREAD_ID}/artifacts`) {
      const artifacts = returning ? [companion('newer.txt'), ...initial] : initial;
      response = {
        body: {
          threadId: THREAD_ID,
          artifacts,
          ...(url.searchParams.get('view') === 'works'
            ? { view: 'works', complete: true, total: artifacts.length, workLineage: 'resolved' }
            : {}),
        },
      };
    }
    if (url.pathname === '/api/workspace/resolve-file-source' && request.method() === 'POST') {
      const body = request.postDataJSON();
      requests.push(body);
      if (body.path === '/project/cat-cafe/home-source.md')
        response = {
          body: {
            kind: 'file',
            worktreeId: canonicalWorktreeId(WORKTREE_ID),
            path: 'home-source.md',
          },
        };
    }
    if (url.pathname === '/api/content-publications/resolve') {
      requests.push(request.postDataJSON());
      response = { status: 409, body: { error: { code: 'source_unavailable' } } };
    }
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  const name = `home-works-${kind}-${width}`;
  try {
    await page.goto(baseUrl);
    await ensureWorkspaceOpen(page);
    const draft = page.locator('[data-guide-id="chat.input"] textarea');
    await draft.fill(`Home card draft ${width} ${kind}`);
    const home = page.getByTestId('f307-workspace-home-page');
    const card = home.getByTestId('workspace-home-artifact-card').filter({ hasText: chosen.name });
    await card.waitFor({ state: 'visible' });
    await page.evaluate(() =>
      document.addEventListener(
        'click',
        (event) => {
          const card = event.target.closest('[data-home-artifact-id]');
          const home = card?.closest('[data-testid="f307-workspace-home-page"]');
          if (card && home)
            window.__homeWorksSource = {
              artifactId: card.getAttribute('data-home-artifact-id'),
              offset: card.getBoundingClientRect().top - home.getBoundingClientRect().top,
            };
        },
        { capture: true },
      ),
    );
    await card.click();
    const source = await page.evaluate(() => window.__homeWorksSource);
    assert.ok(source?.artifactId && Number.isFinite(source.offset));
    const workbench = page.getByTestId('f307-experience-workbench');
    if (publication) {
      await page
        .getByRole('dialog', { name: chosen.name, exact: true })
        .getByRole('button', { name: '批注', exact: true })
        .click();
      await workbench.getByRole('alert').waitFor({ state: 'visible' });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].source.threadId, THREAD_ID);
      assert.equal(requests[0].source.messageId, chosen.sourceMessageId);
      assert.deepEqual(requests[0].source.item, chosen.publicationItem);
    } else {
      await workbench
        .getByTestId('workspace-file-viewer')
        .getByRole('heading', { name: 'F307 Composable Workbench', exact: true })
        .waitFor();
      assert.equal(await workbench.getByTestId('workspace-file-viewer').count(), 1);
      assert.ok(
        requests.some((body) => body.path === chosen.ref),
        'the absolute ledger file was admitted by the original F063 resolver',
      );
      await page.reload();
      await workbench.getByRole('button', { name: '‹ Workspace 首页', exact: true }).waitFor({ state: 'visible' });
    }
    const activeId = await workbench.getAttribute('data-active-surface');
    returning = true;
    const back = publication
      ? workbench.getByRole('button', { name: '返回来源', exact: true })
      : workbench.getByRole('button', { name: '‹ Workspace 首页', exact: true });
    await back.click();
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction((expected) => {
      const home = document.querySelector('[data-testid="f307-workspace-home-page"]');
      const card = Array.from(home?.querySelectorAll('[data-home-artifact-id]') ?? []).find(
        (node) => node.getAttribute('data-home-artifact-id') === expected.artifactId,
      );
      return (
        card?.getAttribute('aria-current') === 'true' &&
        Math.abs(card.getBoundingClientRect().top - home.getBoundingClientRect().top - expected.offset) <= 2
      );
    }, source);
    assert.equal(await card.getAttribute('data-home-artifact-id'), source.artifactId);
    assert.equal(
      await home.getByTestId('workspace-home-artifact-card').count(),
      3,
      'fresh catalogue retains this now-fourth card without duplicating the list',
    );
    assert.ok(await card.evaluate((node) => node === document.activeElement));
    assert.equal(await workbench.getAttribute('data-active-surface'), activeId);
    assert.equal(await draft.inputValue(), `Home card draft ${width} ${kind}`);
    await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
    await writeFile(
      path.join(evidenceDir, `${name}.json`),
      JSON.stringify({ source, activeId, requests, errors, publicationPrepared: false }, null, 2),
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: path.join(evidenceDir, `${name}-failed.png`) }).catch(() => undefined);
    await writeFile(
      path.join(evidenceDir, `${name}-failed.json`),
      JSON.stringify({ requests, errors, failure: String(error) }, null, 2),
    );
    throw error;
  } finally {
    await context.close();
  }
}
