import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort } from './f290-runtime-journey.harness.mjs';

const provider = {
  id: 'github',
  readiness: { ready: true },
  authorizationUrl: ({ state }) => `https://github.test/authorize?state=${state}`,
  authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
};

export async function verifyFirstEntryGuide() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-entry-guide-data-'));
  const evidence = await mkdtemp(path.join(tmpdir(), 'f290-entry-guide-evidence-'));
  const servicePort = await availablePort();
  const hostPort = await availablePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: provider });
  const store = opened.store;
  const owner = await store.consumeBootstrap({ secret: opened.bootstrapSecret, displayName: 'You' });
  const auth = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const completion = await store.completeHumanAuth({ provider: 'github', state: auth.state, code: 'operator' });
  await store.exchangeHumanAuthCompletion(completion.completionToken);
  const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: '首猫引导验证' });
  const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId };
  const intent = await store.createPairingIntent({
    sessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
    hostOrigin: hostUrl,
    nonce: 'first-entry-browser-test',
  });
  const connection = await store.exchangePairingIntent({ ...intent, endpointLabel: 'You 的 Café' });
  const service = await startCollectiveServer({
    store,
    host: '127.0.0.1',
    port: servicePort,
    allowedHostOrigins: [hostUrl],
  });
  const iframeUrl = `${serviceUrl}/?collectiveId=${collective.collectiveId}&hostOrigin=${encodeURIComponent(hostUrl)}`;
  const host = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      `<html><body style="margin:0"><iframe title="Collective" src="${iframeUrl}" style="width:100vw;height:100vh;border:0"></iframe></body></html>`,
    );
  });
  await new Promise((resolve) => host.listen(hostPort, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(
      ({ origin, token }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      },
      { origin: serviceUrl, token: owner.sessionToken },
    );
    await page.goto(hostUrl, { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe[title="Collective"]');
    await frame.getByRole('heading', { name: '先把你的猫带进来' }).waitFor();
    await frame.locator('[data-demo="entry-spotlight"]').waitFor();
    const desktopEntryBounds = await frame
      .locator('[data-demo="entry-caption"], [data-demo="entry-spotlight"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const { left, top, right, bottom } = node.getBoundingClientRect();
          return { left, top, right, bottom };
        }),
      );
    assert.equal(desktopEntryBounds.length, 2);
    assert.ok(
      desktopEntryBounds[0].right <= desktopEntryBounds[1].left ||
        desktopEntryBounds[1].right <= desktopEntryBounds[0].left ||
        desktopEntryBounds[0].bottom <= desktopEntryBounds[1].top ||
        desktopEntryBounds[1].bottom <= desktopEntryBounds[0].top,
      'Entry caption must not cover the real pairing control spotlight',
    );
    await page.screenshot({ path: path.join(evidence, 'unpaired-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const mobileEntryBounds = await frame.locator('[data-demo="entry-spotlight"]').evaluate((node) => {
      const target = document.querySelector('[data-guide-pair]');
      const spotlight = node.getBoundingClientRect();
      const pair = target?.getBoundingClientRect();
      return pair
        ? { spotlight: { left: spotlight.left, top: spotlight.top }, pair: { left: pair.left, top: pair.top } }
        : null;
    });
    assert.ok(
      mobileEntryBounds &&
        Math.abs(mobileEntryBounds.spotlight.left - mobileEntryBounds.pair.left + 7) < 2 &&
        Math.abs(mobileEntryBounds.spotlight.top - mobileEntryBounds.pair.top + 5) < 2,
      `Mobile entry spotlight must track the real pair control: ${JSON.stringify(mobileEntryBounds)}`,
    );
    await page.screenshot({ path: path.join(evidence, 'unpaired-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    assert.equal((await store.listEventsForHuman(owner.sessionToken, collective.collectiveId)).length, 0);
    await frame.getByRole('button', { name: '带猫进来' }).click();
    await page.evaluate(
      ({ origin, connectionId, humanId, ...coordinates }) => {
        document.querySelector('iframe').contentWindow.postMessage(
          {
            type: 'collective:host-context-init',
            bridgeId: 'bridge_guide456',
            ...coordinates,
            connectionId,
            humanId,
            authorityStatus: 'connected',
          },
          origin,
        );
      },
      { origin: serviceUrl, ...coordinates, connectionId: connection.connectionId, humanId: owner.human.humanId },
    );
    await frame.getByText('正在带入伙伴…', { exact: true }).waitFor();
    assert.equal(await frame.getByText('这台 Café 还没有可参与的伙伴。', { exact: true }).count(), 0);
    await store.publishParticipation(connection.endpointCredential, {
      ...coordinates,
      connectionId: connection.connectionId,
      revision: 1,
      agents: [{ catId: 'codex-sol', displayName: '缅因猫（砚砚）', channelIds: ['general'] }],
    });
    await page.evaluate(
      ({ origin, connectionId, humanId, ...coordinates }) => {
        document.querySelector('iframe').contentWindow.postMessage(
          {
            type: 'collective:host-participation-ready',
            bridgeId: 'bridge_guide456',
            ...coordinates,
            connectionId,
            humanId,
            participationRevision: 1,
            catCount: 1,
          },
          origin,
        );
      },
      { origin: serviceUrl, ...coordinates, connectionId: connection.connectionId, humanId: owner.human.humanId },
    );
    await frame.getByRole('heading', { name: '你的伙伴到了' }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(evidence, 'entry-desktop.png'), fullPage: true });
    for (const [beat, heading, target] of [
      [1, '点名，它就在原处回你', '[data-guide-thread]'],
      [2, '别家的猫也在这儿帮忙', '[data-guide-neighbor]'],
      [3, '定下来的事变成工作卡', '[data-guide-work]'],
    ]) {
      await frame.getByRole('button', { name: '下一步', exact: true }).click();
      await frame.locator(`[data-demo-beat="${beat}"]`).waitFor();
      await frame.getByRole('heading', { name: heading }).waitFor();
      await page.waitForTimeout(350);
      const alignment = await frame.locator(target).evaluate((element) => {
        const targetRect = element.getBoundingClientRect();
        const spotRect = document.querySelector('.demo-spotlight')?.getBoundingClientRect();
        return spotRect ? { dx: Math.abs(spotRect.x - targetRect.x), dy: Math.abs(spotRect.y - targetRect.y) } : null;
      });
      assert.ok(
        alignment && alignment.dx <= 12 && alignment.dy <= 12,
        `spotlight misses beat ${beat}: ${JSON.stringify(alignment)}`,
      );
      await page.screenshot({ path: path.join(evidence, `beat-${beat}-desktop.png`), fullPage: true });
    }
    assert.equal((await store.listEventsForHuman(owner.sessionToken, collective.collectiveId)).length, 0);
    await frame.getByRole('button', { name: '我来试试' }).click();
    assert.equal(await frame.locator('[data-demo]').count(), 0);
    await frame.getByText('#general 是公开频道', { exact: false }).waitFor();
    assert.equal((await store.listEventsForHuman(owner.sessionToken, collective.collectiveId)).length, 0);
    await frame.getByPlaceholder('在 #general 里说点什么……').fill('帮我看第一条真实消息');
    await frame.getByRole('button', { name: '发送', exact: true }).click();
    await frame.getByText('帮我看第一条真实消息', { exact: true }).waitFor();
    let request;
    for (let attempt = 0; attempt < 30 && !request; attempt += 1) {
      const events = await store.listEventsForHuman(owner.sessionToken, collective.collectiveId);
      request = events.find((event) => event.body === '帮我看第一条真实消息');
      if (!request) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(request, 'the first real message must be accepted by Service');
    assert.equal(request.recipient.connectionId, connection.connectionId);
    assert.equal(request.recipient.agentId, 'codex-sol');
    await frame.getByText('点名 @缅因猫（砚砚） · 尚无公开回复', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'named-request-waiting-desktop.png'), fullPage: true });
    await store.postAgentMessage(connection.endpointCredential, {
      ...coordinates,
      connectionId: connection.connectionId,
      clientEventId: 'guide-real-reply',
      agent: {
        agentId: 'codex-sol',
        catId: 'codex-sol',
        displayName: '缅因猫（砚砚）',
        sessionRef: 'browser-real-fixture',
      },
      participationRevision: 1,
      replyToEventId: request.eventId,
      location: { channelId: 'general', rootEventId: request.eventId },
      recipient: { kind: 'channel' },
      body: '收到了，这是原处的具名回复。',
    });
    await frame.getByText('随时增减伙伴', { exact: false }).waitFor();
    await frame.getByText('点名 @缅因猫（砚砚） · 已在原处回复', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'real-reply-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await frame.getByRole('button', { name: '频道导航' }).click();
    await frame.getByRole('button', { name: '再看一遍演示' }).first().click();
    await frame.getByRole('heading', { name: '你的伙伴到了' }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(evidence, 'entry-mobile.png'), fullPage: true });
    for (const beat of [1, 2, 3]) {
      await frame.getByRole('button', { name: '下一步', exact: true }).click();
      await frame.locator(`[data-demo-beat="${beat}"]`).waitFor();
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(evidence, `beat-${beat}-mobile.png`), fullPage: true });
    }
    await frame.getByRole('button', { name: '跳过' }).click();
    assert.equal(await frame.locator('[data-demo]').count(), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await frame.getByRole('button', { name: '频道导航' }).click();
    await frame.getByRole('button', { name: '再看一遍演示' }).first().click();
    await frame.getByRole('heading', { name: '你的伙伴到了' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'entry-mobile-reduced-motion.png'), fullPage: true });
    await frame.getByRole('button', { name: '跳过' }).click();
    assert.equal(await frame.locator('[data-demo]').count(), 0);
    assert.equal((await store.listEventsForHuman(owner.sessionToken, collective.collectiveId)).length, 2);
    console.log(JSON.stringify({ evidence, demoEvents: 0, realEvents: 2 }));
  } finally {
    await browser.close();
    await new Promise((resolve) => host.close(resolve));
    await service.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
}
