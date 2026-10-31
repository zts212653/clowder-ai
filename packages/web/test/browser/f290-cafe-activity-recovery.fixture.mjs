import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import {
  defaultHumanAuthProvider,
  openNativeOwnerClient,
  seedDefaultCollective,
} from './f290-default-client.fixture.mjs';
import { disableMockHostPwa } from './f290-mock-host-context.harness.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

export async function ownerActivityRecovery() {
  const ports = await reserveNativeOwnerPorts();
  const directory = await mkdtemp(path.join(tmpdir(), 'f290-entry-service-'));
  const evidence = await mkdtemp(path.join(tmpdir(), 'f290-entry-browser-'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory: directory,
    humanAuthProvider: defaultHumanAuthProvider(),
  });
  const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: [`http://localhost:${ports.hostPort}`],
  });
  let browser;
  let owner;
  try {
    browser = await chromium.launch({ headless: true });
    // Fault-injected API reads and the destination fixture must reach route().
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    await disableMockHostPwa(context, `http://localhost:${ports.hostPort}`);
    context.on('page', (page) => page.on('pageerror', (error) => console.error(error.stack)));
    await context.addInitScript(
      ({ origin, token }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      },
      { origin: server.url, token: seeded.owner.sessionToken },
    );
    owner = await startNativeOwner({
      store: opened.store,
      owner: seeded.owner,
      collectiveId: seeded.coordinates.collectiveId,
      serviceUrl: server.url,
      context,
      ports,
    });
    let { host, embedded, cafe, nativeErrors } = await openNativeOwnerClient({
      context,
      evidence,
      nativeOwner: owner,
      seeded,
      serviceUrl: server.url,
    });
    assert.equal(await host.evaluate(() => 'serviceWorker' in navigator), false);
    cafe = host.getByRole('complementary', { name: '我的 Café', exact: true });
    let unavailable = true;
    const reads = [];
    await context.route(/\/api\/plugins\/collective-connector\/[^/]+\/(work-policy|listening)$/, async (route) => {
      reads.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
      if (unavailable) return route.fulfill({ status: 403, json: { code: 'CONNECTOR_OWNER_MISMATCH' } });
      return route.fallback();
    });
    await embedded.locator('details.collective-menu > summary').click();
    await embedded.getByRole('button', { name: '已允许的任务…', exact: true }).click();
    await cafe.getByRole('alert').waitFor({ timeout: 7_000 });
    await host.screenshot({ path: path.join(evidence, 'settings-read-failed.png'), fullPage: true });
    unavailable = false;
    await cafe.getByRole('button', { name: '重新读取', exact: true }).click();
    await cafe.getByRole('alert').waitFor({ state: 'detached' });
    await cafe.getByText('猫会在频道里回应别人；要接持续的工作，会先来问你。', { exact: true }).waitFor();
    assert.ok(
      reads.every((read) => read.method === 'GET'),
      'recovery must not change listening or Work authority',
    );
    await host.screenshot({ path: path.join(evidence, 'settings-read-recovered.png'), fullPage: true });
    await cafe.getByRole('button', { name: '返回共同体', exact: true }).click();
    const body = '请在这个原请求的位置回应，私人入口只留在我的 Café。';
    assert.equal((await owner.receiveRequest(body)).failed, 0);
    const item = (await owner.connector.listInbox(owner.connection.connectionId)).find(
      (item) => item.event.body === body,
    );
    assert.equal(item?.routeReceipt?.kind, 'thread_message');
    const thread = await owner.threads.get(item.routeReceipt.threadId);
    assert.equal(thread.createdBy, owner.userId);
    const href = `/thread/${encodeURIComponent(thread.id)}`;
    await embedded.locator('details.collective-menu > summary').click();
    await embedded.getByRole('button', { name: '我的日程…', exact: true }).click();
    const link = cafe.getByRole('link', { name: '在家里查看', exact: true });
    await link.waitFor({ timeout: 7_000 });
    assert.equal(await link.getAttribute('href'), href);
    assert.equal((await owner.tasks.listByKind('work')).length, 0, 'a named response cannot manufacture a Work grant');
    await host.screenshot({ path: path.join(evidence, 'private-thread-action.png'), fullPage: true });
    // Destination rendering is a fixture, backed by the real owner ThreadStore.
    // This test proves browser navigation, not the ordinary chat page or a model response.
    await context.route(`**${href}*`, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><meta charset="utf-8"><main aria-label="私人请求目的地">私人请求目的地</main>',
      }),
    );
    await Promise.all([host.waitForURL(`${owner.hostUrl}${href}`), link.click()]);
    await host.getByRole('main', { name: '私人请求目的地', exact: true }).waitFor({ timeout: 5_000 });
    await host.screenshot({ path: path.join(evidence, 'private-thread-destination.png'), fullPage: true });
    assert.deepEqual(nativeErrors, []);
    console.log(
      JSON.stringify({
        evidence,
        destination: href,
        reads: reads.length,
        workTasks: 0,
        destinationRendering: 'fixture',
        modelExecution: false,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        evidence,
        browserPages: browser?.contexts().flatMap((context) => context.pages().map((page) => page.url())),
      }),
    );
    for (const page of browser?.contexts().flatMap((context) => context.pages()) ?? [])
      await page
        .screenshot({ path: path.join(evidence, `failure-${Date.now()}.png`), fullPage: true })
        .catch(() => undefined);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (owner) await owner.close();
    await server.close();
    await ports.close();
    await rm(directory, { recursive: true, force: true });
  }
}
