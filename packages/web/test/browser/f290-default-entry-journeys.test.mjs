import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';
import { openChannelFromCollectiveHome } from './f290-channel-entry.harness.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

// Host fixtures allow up to 40 seconds for an honest production Next start. The outer
// journey must outlive that startup SLA and still leave time for browser assertions.
const HOST_JOURNEY_TIMEOUT = 90_000;

async function createJourneyFixture(testContext, { host = false } = {}) {
  let ports;
  let dataDirectory;
  let service;
  let browser;
  let context;
  let nativeOwner;
  // A failed claim check in the imported global after hook must not skip teardown.
  // Per-test cleanup also owns resources acquired before setup fails or times out.
  testContext.after(async () => {
    const errors = [];
    for (const close of [
      () => context?.close(),
      () => browser?.close(),
      () => nativeOwner?.close(),
      () => ports?.close(),
      () => service?.close(),
      () => dataDirectory && rm(dataDirectory, { recursive: true, force: true }),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Default-entry fixture cleanup failed');
    console.log(JSON.stringify({ fixtureCleanup: testContext.name, completed: true }));
  });
  if (host) ports = await reserveNativeOwnerPorts();
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-default-entry-'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: defaultHumanAuthProvider(),
  });
  const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
  service = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: ports ? [`http://localhost:${ports.hostPort}`] : [],
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(
    ({ origin, token }) => {
      if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
    },
    { origin: service.url, token: seeded.owner.sessionToken },
  );
  if (host) {
    nativeOwner = await startNativeOwner({
      store: opened.store,
      owner: seeded.owner,
      collectiveId: seeded.coordinates.collectiveId,
      serviceUrl: service.url,
      context,
      ports,
    });
  }
  return { context, service, seeded, nativeOwner };
}

registerDefaultEntryJourney(
  {
    journeyId: 'f290-client-default-entry',
    surfaceTestId: 'collective-product-shell',
    title: 'direct Service opens the real Collective home and preserves explicit channel navigation',
    timeout: 30_000,
  },
  async (journey, testContext) => {
    const { context, service, seeded } = await createJourneyFixture(testContext);
    const page = await context.newPage();
    try {
      await journey.enter(page, service.url);
      await page.getByTestId('collective-home').waitFor();
      await journey.arrive(page);
      await openChannelFromCollectiveHome(page, '产品方向');
      await page.getByText(seeded.first.body, { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  },
);

for (const shell of ['classic', 'v2']) {
  test(
    `F290 ${shell} shell rail opens the existing Collective across reload and warm re-entry`,
    { timeout: HOST_JOURNEY_TIMEOUT },
    async (testContext) => {
      const { context, nativeOwner } = await createJourneyFixture(testContext, { host: true });
      const page = await context.newPage();
      const sourceThreadId = `f290-rail-${shell}`;
      const invalidTarget = page.getByText('目标共同家园地址不完整；请从已接入的世界目录重新选择。', { exact: true });
      const collective = page.frameLocator('iframe[title="Collective"]');
      const assertHome = async () => {
        await collective.getByTestId('collective-home').waitFor();
        assert.equal(await invalidTarget.count(), 0);
        assert.equal(await page.locator('iframe[title="Collective"]').count(), 1);
      };
      try {
        await page.addInitScript(
          ({ presentation }) => localStorage.setItem('cat-cafe:shell-presentation', presentation),
          { presentation: shell },
        );
        // The Client-only history effect proves the route has hydrated. The
        // isolated owner supplies no Chat history, so its 404 is still a read.
        const initialHistoryRead = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === '/api/messages' && url.searchParams.get('threadId') === sourceThreadId;
        });
        await page.goto(`${nativeOwner.hostUrl}/thread/${sourceThreadId}`, { waitUntil: 'domcontentloaded' });
        await initialHistoryRead;
        // The persisted v2 choice is applied after hydration. Wait for that
        // requested shell before clicking a control from the initial classic shell.
        if (shell === 'v2') await page.getByTestId('world-rail').waitFor();
        await page.locator('[data-guide-id="nav.collective"]').click();
        await page.waitForURL((url) => url.pathname === '/collective');
        assert.equal(new URL(page.url()).searchParams.get('from'), sourceThreadId);
        await assertHome();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await assertHome();

        await page.getByTestId('settings-button').click();
        await page.waitForURL((url) => url.pathname === '/settings');
        await page.locator('[data-guide-id="nav.collective"]').click();
        await page.waitForURL((url) => url.pathname === '/collective');
        await assertHome();

        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForURL((url) => url.pathname === '/settings');
        await page.goForward({ waitUntil: 'domcontentloaded' });
        await page.waitForURL((url) => url.pathname === '/collective');
        await assertHome();

        await page.goto(`${nativeOwner.hostUrl}/collective?collectiveId=col_target000`, {
          waitUntil: 'domcontentloaded',
        });
        await invalidTarget.waitFor();
        assert.equal(await page.locator('iframe[title="Collective"]').count(), 0);
      } finally {
        await page.close();
      }
    },
  );
}

registerDefaultEntryJourney(
  {
    journeyId: 'f290-host-default-entry',
    surfaceTestId: 'collective-launch-surface',
    title: 'Clowder AI Host opens the canonical Collective Client from /collective',
    timeout: HOST_JOURNEY_TIMEOUT,
  },
  async (journey, testContext) => {
    const { context, nativeOwner } = await createJourneyFixture(testContext, { host: true });
    const page = await context.newPage();
    try {
      await journey.enter(page, `${nativeOwner.hostUrl}/collective`);
      const collective = page.frameLocator('iframe[title="Collective"]');
      await collective.getByTestId('collective-home').waitFor();
      const initialFrame = await page.locator('iframe[title="Collective"]').elementHandle();
      assert.ok(initialFrame);
      const initialClientFrame = await initialFrame.contentFrame();
      assert.ok(initialClientFrame);
      await journey.arrive(page);
      // Home can paint before the authenticated Host bridge is available.
      // Wait for its real navigation control before changing the embedded scene.
      await collective.locator('details.collective-menu > summary').click();
      await collective.getByRole('button', { name: /^我的猫/ }).waitFor();
      await collective.locator('details.collective-menu > summary').click();
      await openChannelFromCollectiveHome(collective, '产品方向');
      assert.equal(initialClientFrame.isDetached(), false, 'the entered Client must survive navigation');
      assert.equal(await page.locator('iframe[title="Collective"]').count(), 1);
      await nativeOwner.receiveRequest('帮我看看这条点名请求', '产品方向');
      const request = (await nativeOwner.connector.listInbox(nativeOwner.connection.connectionId)).find(
        (item) => item.event.body === '帮我看看这条点名请求',
      );
      assert.equal(request?.routeReceipt?.kind, 'thread_message');
      const destination = `/thread/${encodeURIComponent(request.routeReceipt.threadId)}`;
      const evidence = await mkdtemp(path.join(tmpdir(), 'f290-owner-progress-evidence-'));
      await collective.locator('details.collective-menu > summary').click();
      await collective.getByRole('button', { name: '我的日程…', exact: true }).click();
      const cafe = page.getByRole('complementary', { name: '我的 Café', exact: true });
      const requestArticle = cafe.getByRole('article').filter({ hasText: '帮我看看这条点名请求' });
      await requestArticle.getByText('排着队', { exact: true }).waitFor();
      const privateThread = requestArticle.getByRole('link', { name: '在家里查看', exact: true });
      await privateThread.waitFor();
      await privateThread.scrollIntoViewIfNeeded();
      assert.equal(await privateThread.getAttribute('href'), destination);
      assert.equal(initialClientFrame.isDetached(), false, 'the entered Client must survive Host updates');
      assert.equal(await page.locator('iframe[title="Collective"]').count(), 1);
      await page.screenshot({ path: path.join(evidence, 'queued-home-work.png'), fullPage: true });
      console.log(JSON.stringify({ evidence }));
    } finally {
      await page.close();
    }
  },
);
