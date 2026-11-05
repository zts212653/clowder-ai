import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { projectThreadWorks } from '@cat-cafe/shared';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { IMAGE_FIXTURE } from './f309-ordinary-workspace-journey-fixture.mjs';
import {
  startF309OrdinaryWorkspaceJourney,
  stopF309OrdinaryWorkspaceJourney,
} from './f309-ordinary-workspace-journey-runtime.mjs';
import {
  createWorkspaceV3Fixture,
  WORKSPACE_SAMPLE_MARKDOWN,
  WORKSPACE_SAMPLE_THREAD,
} from './f322-b-workspace-v3-fixture.mjs';
import { registerWorkspaceMarkdownJourneys } from './f322-b-workspace-v3-markdown-journey.mjs';
import { registerComposerFocusJourneys } from './f322-composer-focus.journey.mjs';
import { registerToolsEntryJourneys } from './f322-tools-entry.journey.mjs';

let suite;
const evidenceDir = process.env.F322_HOME_EVIDENCE_DIR ?? '/tmp/f322-b-workspace-v3-native';
before(async () => {
  await mkdir(evidenceDir, { recursive: true });
  suite = await startF309OrdinaryWorkspaceJourney();
});
after(async () => {
  if (suite) await stopF309OrdinaryWorkspaceJourney(suite);
});

async function resizeWorkspace(page, width) {
  const home = page.getByTestId('f307-workspace-home-page');
  const separator = page.getByRole('separator', { name: '右侧面板分隔条', exact: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const homeBox = await home.boundingBox();
    assert.ok(homeBox);
    if (Math.abs(homeBox.width - width) <= 2) return;
    const handle = await separator.boundingBox();
    assert.ok(handle, 'Use the original resize control');
    const x = handle.x + handle.width / 2;
    const y = handle.y + Math.min(handle.height / 2, 120);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + homeBox.width - width, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  const actual = (await home.boundingBox()).width;
  assert.ok(Math.abs(actual - width) <= 2, `Workspace width ${actual}, expected ${width}`);
}

async function originalHome(page, language) {
  const home = page.getByTestId('f307-workspace-home-page');
  if (!(await home.isVisible())) {
    const back = page.getByRole('button', {
      name: language === 'en' ? '‹ Workspace home' : '‹ Workspace 首页',
      exact: true,
    });
    if (await back.isVisible()) await back.click();
    else await page.getByTestId('v2-workspace-home').press('Enter');
    await home.waitFor();
  }
  return home;
}

async function refreshOpenPreviewCatalogue(page, card, dialog, fixture, batch = 'initial-preview') {
  const originalCard = await card.elementHandle();
  let releaseRefresh;
  const responsePending = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const pauseCatalogue = async (route) => {
    await responsePending;
    await fixture.answer(route);
  };
  await page.route(`**/api/threads/${WORKSPACE_SAMPLE_THREAD}/artifacts*`, pauseCatalogue, { times: 1 });
  try {
    const latestPublicationTime = Math.max(...fixture.artifacts.map((item) => item.createdAt));
    fixture.setArtifacts([
      ...Array.from({ length: 3 }, (_, index) => ({
        ...fixture.artifacts[1],
        name: `Controlled recent work ${batch} ${index}.png`,
        sourceMessageId: `controlled-recent-${batch}-${index}`,
        url: `/uploads/f322-controlled-recent-${batch}-${index}.png`,
        createdAt: latestPublicationTime + (3 - index) * 1000,
      })),
      ...fixture.artifacts,
    ]);
    await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    await card.waitFor({ state: 'hidden' });
    assert.equal(await originalCard.evaluate((element) => element.isConnected), false);
    assert.equal(
      await dialog.isVisible(),
      true,
      'The original preview stays open during the real pending catalogue read',
    );
  } finally {
    releaseRefresh();
  }
  await card.waitFor({ state: 'visible' });
  assert.equal(await originalCard.evaluate((element) => element.isConnected), false);
}

async function waitForOriginalArtwork(page, dialog, fixture) {
  const owner = dialog.getByTestId('workspace-content-review-surface');
  await owner.waitFor();
  await page.waitForFunction(
    ({ element, contentRef }) => {
      const image = element.querySelector('[data-testid="workspace-content-review-media"]');
      return (
        element.isConnected &&
        element.dataset.contentReady === 'true' &&
        element.dataset.contentRef === contentRef &&
        element.dataset.ownerRevision === '4' &&
        image?.complete &&
        image.naturalWidth > 1 &&
        new URL(image.currentSrc || image.src).pathname.endsWith('/media/4')
      );
    },
    { element: await owner.elementHandle(), contentRef: fixture.image.work.contentRef },
  );
  const image = owner.getByTestId('workspace-content-review-media');
  await image.evaluate((element) => element.decode());
  assert.equal(await owner.getAttribute('data-content-ref'), fixture.image.work.contentRef);
  assert.equal(await owner.getAttribute('data-owner-revision'), '4');
  return owner;
}

async function runCase({ width, language, theme }) {
  const context = await suite.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const fixture = createWorkspaceV3Fixture();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addInitScript(
    ({ language, theme, threadId }) => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', language);
      localStorage.setItem('theme', theme);
      if (localStorage.getItem('cat-cafe:workbench-layout-v2') === null) {
        const id = 'workspace:host:now',
          owner = 'f284-workspace-launcher';
        const old = {
          id,
          type: 'workspace',
          renderer: 'workspace-destination',
          title: '正在发生',
          context: 'Old standalone page',
          objectRef: { kind: 'workspace-destination', id: 'host:now' },
          ownerStateRef: { owner, key: 'host:now' },
          resultTargetRef: { owner, key: `${threadId}:host:now` },
          capabilities: {
            split: true,
            sidecar: true,
            pin: true,
            closePolicy: 'detach-host',
            restorePolicy: 'descriptor',
          },
        };
        localStorage.setItem(
          'cat-cafe:workbench-layout-v2',
          JSON.stringify({
            schemaVersion: 2,
            layoutOwner: 'f307',
            surfaces: [old],
            activeSurfaceId: id,
            pinnedSurfaceIds: [],
            previewSurfaceId: null,
            split: null,
            sidecar: null,
            recentlyClosed: [],
            recentSurfaceIdsByThread: { [threadId]: [id] },
            activity: [],
          }),
        );
      }
    },
    { language, theme, threadId: WORKSPACE_SAMPLE_THREAD },
  );
  await page.route('**/api/**', (route) => fixture.answer(route));
  await page.route('**/uploads/f322-controlled-*.png', (route) => fixture.answer(route));
  const name = `${width}-${language}-${theme}`;
  try {
    await page.goto(new URL(`/thread/${WORKSPACE_SAMPLE_THREAD}`, suite.baseUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await ensureWorkspaceOpen(page);
    const home = page.getByTestId('f307-workspace-home-page');
    await home.waitFor();
    const legacyNow = page.locator(
      '[data-tab-surface-id="workspace:host:now"] [data-workbench-tab-control="activate"]',
    );
    await legacyNow.waitFor();
    await legacyNow.press('Enter');
    await legacyNow.waitFor({ state: 'detached' });
    await home.waitFor();
    assert.equal(await page.getByTestId('workspace-now-v2').count(), 0);
    const closedNow = await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2')));
    assert.ok(!closedNow.surfaces.some((surface) => surface.id === 'workspace:host:now'));
    await page.screenshot({ path: `${evidenceDir}/${name}-legacy-now-home.png` });
    await writeFile(`${evidenceDir}/${name}-legacy-now-proof.json`, JSON.stringify(closedNow, null, 2));
    await resizeWorkspace(page, width);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="f307-workspace-home-page"] [data-testid="workspace-running-object"]')
          .length === 20,
    );
    const running = home.getByTestId('workspace-developing');
    assert.equal(
      await home.getByTestId('workspace-deployment-waits').count(),
      0,
      'The exact all-project empty projection hides the wait section',
    );
    assert.equal(await home.locator(':scope > .home-column > .home-section').count(), 3);
    assert.equal(await home.getByTestId('workspace-running-object').count(), 20);
    assert.equal(await home.locator('button.home-stop').count(), 20);
    assert.equal(await home.locator('[data-testid="workspace-developing"] .home-all').count(), 0);
    assert.deepEqual(await running.locator('.home-live-name').allTextContents(), Array(20).fill('小太阳·砚砚'));
    for (const node of await running.locator('.home-live-name').all()) {
      assert.equal(await node.evaluate((el) => getComputedStyle(el).textOverflow), 'ellipsis');
      assert.ok(await node.evaluate((el) => el.getBoundingClientRect().width > 0), 'Nickname remains visible');
    }
    for (const metadata of await running.locator('.home-live-status, .home-live-clock').all()) {
      assert.equal(
        await metadata.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
        'Accepted Home metadata stays readable while the full nickname remains in DOM and avatar label',
      );
    }
    assert.ok(
      await home
        .getByTestId('workspace-running-object')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height >= 48),
    );
    assert.equal(await home.getByTestId('workspace-running-here').count(), 2);
    assert.ok((await home.getByTestId('workspace-running-here').first().innerText()).trimEnd().endsWith(' ·'));
    assert.equal(await running.getByRole('img', { name: '小太阳·砚砚', exact: true }).count(), 20);
    await running
      .locator('.home-live-heading [role="img"] img')
      .evaluateAll((nodes) => Promise.all(nodes.map((node) => node.decode())));
    const avatars = await running.locator('.home-live-heading [role="img"]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        html: node.outerHTML,
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
        imageWidth: node.querySelector('img')?.naturalWidth,
        childWidth: node.querySelector('div')?.getBoundingClientRect().width,
        imageBox: node.querySelector('img')?.getBoundingClientRect().toJSON(),
        imageVisibility: node.querySelector('img') && getComputedStyle(node.querySelector('img')).visibility,
        display: getComputedStyle(node).display,
      })),
    );
    await writeFile(`${evidenceDir}/${name}-avatars.json`, JSON.stringify(avatars, null, 2));
    assert.ok(
      avatars.every((item) => item.width >= 20 && item.height >= 20),
      'Every row has a visible avatar with its original size',
    );
    assert.equal(await running.locator('.home-live-status[data-tone="wait"]').count(), 10);
    const waitColor = await running
      .locator('.home-live-status[data-tone="wait"] .home-execution-status-dot')
      .first()
      .evaluate((element) => {
        const color = getComputedStyle(element).backgroundColor;
        const probe = document.createElement('span');
        probe.style.color = 'var(--semantic-warning)';
        element.appendChild(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return { color, expected };
      });
    assert.equal(waitColor.color, waitColor.expected, 'Background wait dot uses the actual amber warning token');
    assert.equal(await home.getByTestId('workspace-home-status-summary').count(), 1);
    await home
      .getByTestId('workspace-home-status-summary')
      .filter({ hasText: language === 'en' ? 'Session 4' : '第 4 段会话' })
      .waitFor();
    assert.doesNotMatch(await home.getByTestId('workspace-home-status-summary').innerText(), /其他对话/);
    const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
    const draft = 'Workspace 原 Chat 草稿和选择位置';
    await composer.fill(draft);
    await composer.evaluate((input) => input.setSelectionRange(3, 8));
    await page.screenshot({ path: `${evidenceDir}/${name}-home-top.png` });

    const cards = home.getByTestId('workspace-home-artifact-card');
    await cards.first().scrollIntoViewIfNeeded();
    const entryKey = await cards.first().getAttribute('data-home-artifact-id');
    const escapedEntryKey = await page.evaluate((key) => CSS.escape(key), entryKey);
    const entryCard = home.locator(`[data-home-artifact-id="${escapedEntryKey}"]`);
    assert.equal(await cards.count(), 3);
    assert.match(await cards.first().innerText(), language === 'en' ? /Version 4/ : /第 4 版/);
    assert.doesNotMatch(await cards.first().innerText(), language === 'en' ? /Version 9/ : /第 9 版/);
    assert.doesNotMatch(await cards.nth(1).innerText(), /Unknown version|版本未知/);
    await page.screenshot({ path: `${evidenceDir}/${name}-home-works.png` });
    await cards.first().press('Enter');
    const dialog = page.getByRole('dialog', { name: fixture.image.name, exact: true });
    await dialog.waitFor();
    // Main #5603 routes Home to the original F309 floating owner. Avatars are
    // also images in this dialog; decode the exact artwork instead of all img.
    await waitForOriginalArtwork(page, dialog, fixture);
    assert.equal(await dialog.getByTestId('lightbox-open-workspace').count(), 1);
    assert.equal(
      await dialog.getByRole('link', { name: language === 'en' ? 'Download' : '下载', exact: true }).count(),
      0,
    );
    await page.screenshot({ path: `${evidenceDir}/${name}-image.png` });
    // The original floating host owns keyboard trapping and the same composer.
    // Legacy HomeArtifactLightbox paging remains covered in its existing units.
    const closePreview = dialog.getByTitle(language === 'en' ? 'Close' : '关闭', { exact: true });
    await closePreview.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    await page.keyboard.press('Tab');
    assert.equal(await closePreview.evaluate((element) => element === document.activeElement), true);
    await refreshOpenPreviewCatalogue(page, entryCard, dialog, fixture);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await home.isVisible(), true);
    assert.equal(await entryCard.evaluate((element) => document.activeElement === element), true);
    assert.equal(await cards.count(), 3, 'The bounded summary retains the exact preview entry among newer works');
    await entryCard.click();
    await closePreview.click();
    assert.equal(await page.getByRole('dialog').count(), 0);

    const menu = entryCard.locator('..').locator('details');
    await menu.locator('summary').press('Enter');
    const download = menu.getByRole('link', { name: language === 'en' ? 'Download' : '下载', exact: true });
    assert.ok((await download.getAttribute('href')).endsWith(fixture.image.url));
    assert.equal(await download.getAttribute('download'), fixture.image.name);
    const completedDownload = page.waitForEvent('download');
    await download.press('Enter');
    const downloaded = await completedDownload;
    assert.equal(await downloaded.failure(), null);
    assert.equal(downloaded.suggestedFilename(), fixture.image.name);
    const bytes = await readFile(await downloaded.path());
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      createHash('sha256').update(IMAGE_FIXTURE.bytes).digest('hex'),
      'The original asset bytes and filename are actually downloaded',
    );
    await download.press('Escape');
    assert.equal(await menu.getAttribute('open'), null);
    await entryCard.click();
    await dialog.getByTestId('lightbox-open-workspace').click();
    await dialog.waitFor({ state: 'detached' });
    const workspaceReview = page.getByTestId('workspace-content-review-surface');
    await workspaceReview.waitFor();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="workspace-content-review-surface"]')?.dataset.contentReady === 'true',
    );
    assert.equal(await workspaceReview.getAttribute('data-content-ref'), fixture.image.work.contentRef);
    assert.equal(await workspaceReview.getAttribute('data-owner-revision'), '4');
    await originalHome(page, language);
    assert.equal(await entryCard.getAttribute('aria-current'), 'true');
    assert.equal(await composer.inputValue(), draft);
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);

    const nextEntry = home.locator('[data-home-artifact-id]:not([aria-current="true"])').first();
    const nextEntryKey = await nextEntry.getAttribute('data-home-artifact-id');
    assert.ok(nextEntryKey);
    assert.notEqual(nextEntryKey, entryKey);
    const escapedNextEntryKey = await page.evaluate((key) => CSS.escape(key), nextEntryKey);
    const localEntryCard = home.locator(`[data-home-artifact-id="${escapedNextEntryKey}"]`);
    await localEntryCard.press('Enter');
    const nextDialog = page.getByRole('dialog');
    await nextDialog.waitFor();
    await refreshOpenPreviewCatalogue(page, localEntryCard, nextDialog, fixture, 'after-reader-return');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await cards.count(), 3);
    assert.equal(await localEntryCard.evaluate((element) => document.activeElement === element), true);
    assert.equal(await entryCard.getAttribute('aria-current'), 'true', 'Keep the original owner return card as well');
    assert.equal(await home.locator('[data-home-artifact-return]').getAttribute('data-home-artifact-return'), 'ready');
    await page.screenshot({ path: `${evidenceDir}/${name}-dual-origin.png` });

    const all = language === 'en' ? 'All ›' : '全部 ›';
    await home.locator('section[aria-labelledby="home-status-title"]').getByRole('button', { name: all }).click();
    await page.getByTestId('workspace-status-v2').waitFor();
    assert.equal(await home.isVisible(), false);
    await originalHome(page, language);
    await home.locator('section[aria-labelledby="home-works-title"]').getByRole('button', { name: all }).press('Enter');
    const works = page.getByTestId('v2-works-panel');
    await works.waitFor();
    await works.getByPlaceholder(language === 'en' ? 'Search work names…' : '搜索作品名称…').waitFor();
    const workCount = projectThreadWorks(fixture.artifacts, true).length;
    await works.getByText(language === 'en' ? `${workCount} works` : `共 ${workCount} 件`, { exact: true }).waitFor();
    assert.equal(await works.getByTestId('workspace-home-artifact-card').count(), workCount);
    assert.doesNotMatch(await works.innerText(), /Unknown version|版本未知/);
    await page.screenshot({ path: `${evidenceDir}/${name}-all-works.png` });
    assert.equal(await home.isVisible(), false);
    await originalHome(page, language);
    assert.equal(await composer.inputValue(), draft);
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);

    const toolsTrigger = page.getByTestId('v2-workspace-tools');
    await toolsTrigger.press('Enter');
    const tools = page.locator('[data-v2-workspace-menu]:not([hidden])');
    await tools.waitFor();
    // Main #5589 retired the duplicate Now page; all running work stays on Home.
    assert.equal(await tools.getByTestId('workspace-launcher-now').count(), 0);
    await page.keyboard.press('Escape');
    await tools.waitFor({ state: 'hidden' });
    assert.equal(await home.getByTestId('workspace-running-object').count(), 20);
    await toolsTrigger.click();
    await tools.waitFor();
    assert.equal(await tools.locator('[data-workspace-destination]').count(), 17);
    assert.deepEqual(
      await tools.locator('.home-group-title').allTextContents(),
      language === 'en' ? ['Recent work pages', 'Activity', 'Code', 'Other'] : ['最近的工作页', '活动', '代码', '其他'],
    );
    assert.equal(await tools.getByTestId('workspace-tool-recent').count(), 3);
    await tools.getByTestId('workspace-launcher-trajectory').press('Enter');
    await tools.waitFor({ state: 'hidden' });
    await toolsTrigger.click();
    await tools.waitFor();
    await tools.getByTestId('workspace-launcher-theater').click();
    await tools.waitFor({ state: 'hidden' });
    await toolsTrigger.click();
    await tools.waitFor();
    assert.ok((await tools.getByTestId('workspace-tool-recent').count()) <= 3);
    const search = tools.getByTestId('workspace-launcher-search');
    await search.fill('f322-controlled.md');
    await tools.getByTestId('workspace-launcher-file-result').first().waitFor();
    await search.press('Escape');
    await tools.waitFor({ state: 'hidden' });
    assert.equal(await toolsTrigger.evaluate((element) => document.activeElement === element), true);
    assert.equal(await composer.inputValue(), draft);
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
    const exitAttention = page.getByRole('button', {
      name: language === 'en' ? 'Exit full window' : '退出整窗',
      exact: true,
    });
    if (await exitAttention.isVisible()) await exitAttention.click();
    await page.getByTestId('v2-workspace-home').click();
    await home.waitFor();
    await resizeWorkspace(page, width);
    // A latest document remains the latest work and uses a compact card instead of an older image.
    const savedArtifacts = fixture.artifacts;
    const latestDocument = {
      ...WORKSPACE_SAMPLE_MARKDOWN,
      createdAt: Math.max(...savedArtifacts.map((item) => item.createdAt)) + 1000,
    };
    fixture.setArtifacts([latestDocument, ...savedArtifacts.filter((item) => item !== WORKSPACE_SAMPLE_MARKDOWN)]);
    await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    await page.waitForFunction(
      (name) =>
        document
          .querySelector('[data-testid="f307-workspace-home-page"] [data-testid="workspace-home-artifact-card"]')
          ?.textContent.includes(name),
      latestDocument.name,
    );
    assert.match(await cards.first().getAttribute('class'), /home-work-summary/);
    assert.equal(await cards.first().locator('img').count(), 0);
    await page.screenshot({ path: `${evidenceDir}/${name}-latest-document.png` });
    fixture.setArtifacts(savedArtifacts);
    await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    await cards.first().filter({ hasText: savedArtifacts[0].name }).waitFor();
    // All mutations below address only these explicitly controlled fixture executions.
    const other = {
      ...fixture.executions[2],
      catId: 'codex-sol',
      cancelability: {
        state: 'cancelable',
        target: { ...fixture.executions[2].cancelability.target, catId: 'codex-sol' },
      },
    };
    fixture.setExecutions([fixture.executions[0], fixture.executions[1], other]);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="f307-workspace-home-page"] [data-testid="workspace-running-object"]')
          .length === 3,
    );
    const firstRow = home.locator('[data-testid="workspace-running-object"][data-execution-id="sample-parent"]');
    await firstRow.locator('button.home-stop').click();
    const stopDialog = page.getByRole('dialog');
    await stopDialog.waitFor();
    assert.equal(fixture.calls.filter((call) => call.path.endsWith('/cancel')).length, 0);
    await stopDialog.getByRole('button', { name: language === 'en' ? 'Cancel' : '取消', exact: true }).click();
    await firstRow.locator('button.home-stop').focus();
    await page.keyboard.press('Enter');
    await page.screenshot({ path: `${evidenceDir}/${name}-stop-confirm.png` });
    await stopDialog.getByRole('button', { name: language === 'en' ? 'Stop' : '停止', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="f307-workspace-home-page"] [data-testid="workspace-running-object"]')
          .length === 2,
    );
    assert.deepEqual(
      fixture.calls
        .filter((call) => call.path.endsWith('/cancel'))
        .map((call) => [call.method, call.path, JSON.parse(call.body)]),
      [
        [
          'POST',
          `/api/threads/${WORKSPACE_SAMPLE_THREAD}/executions/live/sample-parent/cancel`,
          { catId: 'codex61-sol' },
        ],
      ],
    );
    assert.ok(
      fixture.executions.some((item) => item.executionId === other.executionId),
      'The other cat continues',
    );
    // Both the managed command and a different conversation must land on their own original Chat row.
    for (const item of [fixture.executions.find((run) => run.kind === 'managed_command'), other]) {
      const row = home
        .getByTestId('workspace-running-object')
        .filter({ has: page.locator(`a[href="/thread/${item.threadId}"]`) });
      await row.getByTestId('workspace-open-running-object').click();
      const executionRow = page.locator(`[data-testid="execution-row"][data-execution-thread-id="${item.threadId}"]`);
      await executionRow.waitFor();
      await page.waitForFunction(
        (id) => document.activeElement?.getAttribute('data-execution-thread-id') === id,
        item.threadId,
      );
      await page.screenshot({ path: `${evidenceDir}/${name}-located-${item.kind}.png` });
      if (item.threadId !== WORKSPACE_SAMPLE_THREAD) await page.goBack();
      await ensureWorkspaceOpen(page);
      await home.waitFor();
    }
    assert.equal(await composer.inputValue(), draft);
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
    const catalogueReads = fixture.calls.filter((call) => call.path.endsWith('/artifacts')).length;
    const freshImage = {
      ...fixture.artifacts[1],
      name: 'Controlled newly published image.png',
      createdAt: Math.max(...fixture.artifacts.map((item) => item.createdAt)) + 1000,
    };
    fixture.setArtifacts([freshImage, ...fixture.artifacts]);
    await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    await cards.filter({ hasText: freshImage.name }).waitFor();
    assert.ok(fixture.calls.filter((call) => call.path.endsWith('/artifacts')).length > catalogueReads);
    await cards.filter({ hasText: freshImage.name }).click();
    const retained = page.getByRole('dialog', { name: freshImage.name, exact: true });
    await retained.waitFor();
    await waitForOriginalArtwork(page, retained, fixture);
    fixture.setArtifacts([]);
    await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="workspace-home-artifact-card"]').length === 0,
    );
    assert.equal(await cards.count(), 0);
    // Catalogue membership is a projection; removing it does not revoke the
    // independently readable original publication owner or invent an unavailable result.
    assert.equal(await retained.isVisible(), true);
    assert.equal(
      await retained.getByTestId('workspace-content-review-surface').getAttribute('data-content-ref'),
      fixture.image.work.contentRef,
    );
    assert.equal(
      await home.getByText(language === 'en' ? 'Cannot open this work' : '无法打开这件作品', { exact: true }).count(),
      0,
    );
    await retained.getByTitle(language === 'en' ? 'Close' : '关闭', { exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await composer.inputValue(), draft);
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(`${evidenceDir}/${name}-calls.json`, JSON.stringify({ errors, calls: fixture.calls }, null, 2));
    await page.screenshot({ path: `${evidenceDir}/${name}-final.png` }).catch(() => {});
    await context.close();
  }
}

for (const parameters of [
  { width: 288, language: 'zh', theme: 'light' },
  { width: 480, language: 'en', theme: 'dark' },
  { width: 288, language: 'en', theme: 'light' },
  { width: 480, language: 'zh', theme: 'dark' },
])
  test(`F322 B Workspace v3 original page ${parameters.width}/${parameters.language}/${parameters.theme}`, () =>
    runCase(parameters));

registerWorkspaceMarkdownJourneys(() => suite, resizeWorkspace, evidenceDir);

registerToolsEntryJourneys(() => suite);
registerComposerFocusJourneys(() => suite);
