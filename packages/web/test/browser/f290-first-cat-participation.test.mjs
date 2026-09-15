import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { verifyFirstCatOwnerControls } from './f290-first-cat-owner.harness.mjs';
import { availablePort } from './f290-runtime-journey.harness.mjs';

// Synthetic authenticated fixture only. Real GitHub two-Human/cat UAT remains a separate acceptance gate.
const provider = {
  id: 'github',
  readiness: { ready: true },
  authorizationUrl: ({ state }) => `https://github.test/authorize?state=${state}`,
  authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
};

test(
  'first-cat Client preserves exact recipient/topic, recovers accepted response loss, and refuses revoked targets',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'f290-first-cat-browser-'));
    const evidence = await mkdtemp(path.join(tmpdir(), 'f290-first-cat-evidence-'));
    const port = await availablePort();
    const hostPort = await availablePort();
    const allowedHostOrigins = [`http://127.0.0.1:${hostPort}`];
    const url = `http://127.0.0.1:${port}`;
    const opened = await CollectiveServiceStore.open({ dataDirectory: directory, humanAuthProvider: provider });
    let store = opened.store;
    const owner = await store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'Test Owner' });
    const auth = await store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'bind' },
      sessionToken: owner.sessionToken,
    });
    const completion = await store.completeHumanAuth({ provider: 'github', state: auth.state, code: 'Test Owner' });
    await store.exchangeHumanAuthCompletion(completion.completionToken);
    const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: '首猫自动化验证' });
    const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId };
    const pair = async () => {
      const intent = await store.createPairingIntent({
        sessionToken: owner.sessionToken,
        collectiveId: collective.collectiveId,
        hostOrigin: 'http://localhost:5182',
        nonce: 'first-cat-browser-test',
      });
      const connection = await store.exchangePairingIntent({ ...intent, endpointLabel: 'Same Café label' });
      await store.publishParticipation(connection.endpointCredential, {
        ...coordinates,
        connectionId: connection.connectionId,
        revision: 1,
        agents: [{ catId: 'codex-astra', displayName: 'Astra', channelIds: ['general', 'workshop'] }],
      });
      return connection;
    };
    const [first, second] = await Promise.all([pair(), pair()]);
    const root = await store.postHumanMessage(owner.sessionToken, {
      ...coordinates,
      clientEventId: 'root',
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '原话题 · 自动化测试身份，不计真实 GitHub UAT',
    });
    await store.postHumanMessage(owner.sessionToken, {
      ...coordinates,
      clientEventId: 'workshop',
      location: { channelId: 'workshop' },
      recipient: { kind: 'channel' },
      body: 'WORKSHOP_CANARY',
    });
    let service = await startCollectiveServer({ store, host: '127.0.0.1', port, allowedHostOrigins });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      await page.addInitScript(
        (token) => sessionStorage.setItem(`collective-session:${location.origin}`, token),
        owner.sessionToken,
      );
      await page.goto(`${url}/?collectiveId=${collective.collectiveId}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '# general' }).waitFor();
      assert.equal(await page.getByText('WORKSHOP_CANARY', { exact: true }).count(), 0);
      const key = (connection) => `${store.serviceInstanceId}:${connection.connectionId}:codex-astra`;
      const recipientSelect = page.getByLabel('请求谁回应');
      const options = await recipientSelect.locator('option').allTextContents();
      assert.equal(options.filter((label) => label.includes('Astra')).length, 2);
      assert.equal(new Set(options).size, 3, 'same-name options must remain visibly distinct');
      await recipientSelect.selectOption(key(second));
      await page.getByPlaceholder('发消息到 # general').fill('普通请求不自动产生持续委托');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.locator('.message-body').filter({ hasText: '普通请求不自动产生持续委托' }).waitFor();
      let events = await store.listEventsForHuman(owner.sessionToken, collective.collectiveId);
      const ordinary = events.find((event) => event.body === '普通请求不自动产生持续委托');
      assert.equal(ordinary.recipient.connectionId, second.connectionId);
      assert.equal(ordinary.workRequest, undefined);
      assert.deepEqual(ordinary.location, { channelId: 'general' });

      await page.locator(`[data-event-id="${root.eventId}"]`).hover();
      await page
        .locator(`[data-event-id="${root.eventId}"]`)
        .getByRole('button', { name: '回复', exact: true })
        .click();
      const topic = page.getByRole('complementary', { name: '话题' });
      await topic.getByLabel('请求谁回应').selectOption(key(first));
      await topic.getByLabel('请求持续处理并回到此话题').check();
      await topic.getByPlaceholder('回复 Test Owner').fill('请在原话题持续处理并回流');
      await topic.getByRole('button', { name: '发送', exact: true }).click();
      await topic.locator('.message-body').filter({ hasText: '请在原话题持续处理并回流' }).waitFor();
      events = await store.listEventsForHuman(owner.sessionToken, collective.collectiveId);
      const entrusted = events.find((event) => event.body === '请在原话题持续处理并回流');
      assert.deepEqual(entrusted.location, { channelId: 'general', rootEventId: root.eventId });
      assert.equal(entrusted.recipient.connectionId, first.connectionId);
      assert.equal(entrusted.workRequest, 'entrust');
      await page.screenshot({ path: path.join(evidence, 'desktop-topic.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(evidence, 'mobile-topic.png'), fullPage: true });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'mobile must not overflow horizontally',
      );
      for (const button of [topic.getByLabel('关闭话题'), topic.getByRole('button', { name: '发送', exact: true })]) {
        const box = await button.boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= 390,
          'mobile topic controls must remain inside the visible viewport',
        );
      }
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByLabel('关闭话题').click();
      await verifyFirstCatOwnerControls({
        browser,
        hostPort,
        serviceUrl: url,
        coordinates,
        owner,
        connections: [first, second],
        evidence,
      });

      await recipientSelect.selectOption('');
      const operationIds = [];
      await page.route('**/api/events/human', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        operationIds.push(route.request().postDataJSON().clientEventId);
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        if (operationIds.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      await page.getByPlaceholder('发消息到 # general').fill('accepted 丢响应后重试同一条');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('尚未确认送达，可以重试', { exact: true }).waitFor();
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '# general' }).waitFor();
      await page.getByPlaceholder('发消息到 # general').fill('accepted 丢响应后重试同一条');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('已进入共同现场；这不代表某只猫已经接住', { exact: true }).waitFor();
      assert.equal(operationIds.length, 2);
      assert.equal(operationIds[0], operationIds[1]);
      await page.unroute('**/api/events/human');
      events = await store.listEventsForHuman(owner.sessionToken, collective.collectiveId);
      assert.equal(events.filter((event) => event.body === 'accepted 丢响应后重试同一条').length, 1);

      await service.close();
      store = (await CollectiveServiceStore.open({ dataDirectory: directory, humanAuthProvider: provider })).store;
      service = await startCollectiveServer({ store, host: '127.0.0.1', port, allowedHostOrigins });
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('普通请求不自动产生持续委托', { exact: true }).waitFor();
      await recipientSelect.selectOption(key(first));
      await store.revokeConnection({
        sessionToken: owner.sessionToken,
        collectiveId: collective.collectiveId,
        connectionId: first.connectionId,
      });
      await page.getByRole('option', { name: '参与设置已变化，请重新选择' }).waitFor({ state: 'attached' });
      await page.getByPlaceholder('发消息到 # general').fill('撤权后不得送达');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('尚未确认送达，可以重试', { exact: true }).waitFor();
      events = await store.listEventsForHuman(owner.sessionToken, collective.collectiveId);
      assert.equal(
        events.some((event) => event.body === '撤权后不得送达'),
        false,
      );
      assert.ok(
        events.some((event) => event.eventId === entrusted.eventId),
        'revoke retains original request history',
      );
      await page.getByLabel('选择频道', { exact: true }).selectOption('workshop');
      await page.getByText('WORKSHOP_CANARY', { exact: true }).waitFor();
      assert.equal(
        await recipientSelect.inputValue(),
        '',
        'changing channel clears stale recipient instead of retargeting',
      );
      console.log(
        JSON.stringify({
          evidence,
          syntheticIdentity: true,
          realGitHubUat: 'open',
          eventCount: events.length,
          recoveredOperationCount: 1,
        }),
      );
    } finally {
      await browser.close();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
