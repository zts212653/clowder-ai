import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function defaultHumanAuthProvider() {
  return {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://github.fixture.test/?state=${state}`,
    authenticate: async ({ code }) => ({
      providerSubject: code,
      handle: code,
      displayName: code === 'operator' ? 'You' : '吴浪',
      ...(code === 'operator' ? { avatarUrl: 'https://avatars.fixture.test/owner.jpg' } : {}),
    }),
  };
}

export async function verifyStandaloneClient({ context, evidence, seeded, serviceUrl }) {
  await context.route('https://avatars.fixture.test/owner.jpg', async (route) =>
    route.fulfill({
      contentType: 'image/jpeg',
      body: await readFile(path.join(root, 'packages/web/public/avatars/owner.jpg')),
    }),
  );
  await context.addInitScript(
    ({ origin, token }) => {
      if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
    },
    { origin: serviceUrl, token: seeded.owner.sessionToken },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(serviceUrl, { waitUntil: 'networkidle' });
  await page
    .getByRole('navigation', { name: '频道', exact: true })
    .getByRole('button', { name: /产品方向/ })
    .click();
  await page.getByText(seeded.first.body, { exact: true }).waitFor();
  const ownerAvatar = page.locator(`[data-event-id="${seeded.first.eventId}"] .avatar img`);
  assert.equal(await ownerAvatar.count(), 1, 'the message must render the authenticated Human profile image');
  await ownerAvatar.evaluate((image) => image.decode());
  assert.equal(new URL(page.url()).search, '', 'default product entry must not require a query gate');
  assert.equal(await page.getByText('演示数据', { exact: false }).count(), 0);
  await page.getByText('1 个 Café · 4 位成员', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'default-channel-1440.png'), fullPage: true });
  await page.getByRole('button', { name: /1 条回复/ }).click();
  await page.getByRole('complementary', { name: '话题', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '回复 小星星 · 砚砚' }).fill('这一段就从这里继续，原消息的位置不变。');
  await page
    .getByRole('complementary', { name: '话题', exact: true })
    .getByRole('button', { name: '发送', exact: true })
    .click();
  await page
    .getByRole('complementary', { name: '话题', exact: true })
    .getByText('这一段就从这里继续，原消息的位置不变。', { exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(evidence, 'default-topic-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '在频道中查看', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '# 产品方向', exact: true }).waitFor();
  await page.getByRole('button', { name: /2 条回复/ }).waitFor();
  await page.getByRole('button', { name: '查看 You', exact: true }).first().click();
  await page.getByRole('complementary', { name: '成员资料', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭成员资料', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '频道导航', exact: true }).click();
  await page
    .getByRole('navigation', { name: '频道', exact: true })
    .getByRole('button', { name: /插件共建/ })
    .click();
  await page.getByRole('heading', { name: '# 插件共建', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(evidence, 'default-channel-mobile.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(evidence, 'default-channel-dark.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
}

export async function openNativeOwnerClient({ context, evidence, nativeOwner, seeded, serviceUrl }) {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === serviceUrl || url.origin === nativeOwner.apiUrl) return route.continue();
    await route.abort('blockedbyclient');
    throw new Error(`Unexpected API destination in isolated journey: ${url.origin}`);
  });
  const host = await context.newPage();
  await host.addInitScript(() => {
    globalThis.__f290WorldDirectories = [];
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'collective:client-world-directory') {
        globalThis.__f290WorldDirectories.push(event.data);
      }
    });
  });
  const nativeErrors = [];
  host.on('pageerror', (error) => nativeErrors.push(error.message));
  await host.goto(`${nativeOwner.hostUrl}/collective`, { waitUntil: 'networkidle' });
  await host.waitForFunction(
    ({ serviceInstanceId, collectiveId }) =>
      globalThis.__f290WorldDirectories?.some(
        (directory) =>
          directory.state === 'ready' &&
          directory.serviceInstanceId === serviceInstanceId &&
          directory.memberships.some((membership) => membership.collectiveId === collectiveId),
      ),
    seeded.coordinates,
  );
  const worldDirectory = await host.evaluate(
    ({ serviceInstanceId }) =>
      globalThis.__f290WorldDirectories.find(
        (directory) => directory.state === 'ready' && directory.serviceInstanceId === serviceInstanceId,
      ),
    seeded.coordinates,
  );
  assert.equal(worldDirectory.humanId, seeded.first.actor.humanId);
  assert.deepEqual(
    worldDirectory.memberships.map((membership) => membership.collectiveId),
    [seeded.coordinates.collectiveId],
  );
  assert.equal('sessionToken' in worldDirectory, false);
  assert.equal('privateThreadId' in worldDirectory, false);
  const embedded = host.frameLocator('iframe[title="Collective"]');
  await embedded
    .getByRole('navigation', { name: '频道', exact: true })
    .getByRole('button', { name: /产品方向/ })
    .click();
  await embedded.getByRole('button', { name: '我的 Café', exact: true }).waitFor();
  await host.screenshot({ path: path.join(evidence, 'default-embedded-channel-1440.png'), fullPage: true });
  await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
  const cafe = host.getByRole('complementary', { name: '我的 Café', exact: true });
  await cafe.getByText('正在本频道参与', { exact: true }).first().waitFor();
  assert.equal(await cafe.getByText('带它加入', { exact: true }).count(), 0);
  assert.equal(await cafe.getByText('暂时无法公共参与', { exact: true }).count(), 1);
  const route = await nativeOwner.connector.getHostRoute(nativeOwner.connection.connectionId);
  assert.ok(route);
  assert.deepEqual(Object.keys(route.channelRoutes).sort(), ['general', '产品方向', '插件共建']);
  assert.deepEqual(Object.keys(route.channelRoutes.general.participants).sort(), ['codex-sol', 'fable-5']);
  assert.deepEqual(Object.keys(route.channelRoutes['产品方向'].participants).sort(), ['codex-sol', 'fable-5']);
  assert.deepEqual(Object.keys(route.channelRoutes['插件共建'].participants).sort(), ['codex-sol', 'fable-5']);
  assert.equal(
    Object.values(route.agentRoutes).some((binding) => binding.standingWork),
    false,
    'automatic public participation never grants private execution',
  );
  const listening = await nativeOwner.connector.setStandingInterest(
    nativeOwner.connection.connectionId,
    { catId: nativeOwner.cat.id, channelId: '产品方向', state: 'listen' },
    route.attentionRevision,
  );
  assert.equal(listening.revision, route.revision, 'attention preference must not republish participation');
  assert.equal(listening.attentionRevision, 1);
  await cafe.getByText('正在本频道参与 · 值守回应请求', { exact: true }).waitFor({ timeout: 7_000 });
  await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
  return { cafe, embedded, host, nativeErrors };
}

export async function setupResponseRequest({ cafe, embedded, nativeOwner }) {
  const responseRequest = '这件事谁家在做？';
  const response = '我家在跟进。';
  const composer = embedded.getByPlaceholder('在 #产品方向 里说点什么……');
  await composer.fill(responseRequest);
  await embedded.locator('form.composer').getByRole('button', { name: '更多输入选项', exact: true }).click();
  await embedded.getByLabel('希望伙伴回应', { exact: true }).check();
  await embedded.getByRole('button', { name: '发送', exact: true }).click();
  await embedded.getByText(responseRequest, { exact: true }).waitFor();
  await embedded.getByText('希望伙伴回应 · 尚未有人回应', { exact: true }).waitFor();
  assert.equal((await nativeOwner.queuedForChannel('产品方向')).length, 0);
  assert.equal((await nativeOwner.dispatchPending()).failed, 0);
  const responseQueue = await nativeOwner.queuedForChannel('产品方向');
  assert.equal(responseQueue.length, 1);
  assert.deepEqual(responseQueue[0].targetCats, [nativeOwner.cat.id]);
  const attentionItem = (await nativeOwner.connector.listInbox(nativeOwner.connection.connectionId)).find(
    (item) => item.event.body === responseRequest,
  );
  assert.deepEqual(attentionItem.routeReceipt.attention, {
    request: 'response_requested',
    state: 'wake_queued',
    catId: nativeOwner.cat.id,
    interestRevision: 1,
  });
  await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
  const responseArticle = cafe.getByRole('article').filter({ hasText: responseRequest });
  await responseArticle.getByText('已送达；一位值守伙伴已进入回应队列', { exact: true }).waitFor();
  assert.equal(await responseArticle.getByRole('button', { name: '交给它持续处理', exact: true }).count(), 0);
  await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
  return { composer, response, responseRequest };
}

// Fixtures establish isolated Service records through its own APIs. The page
// always renders the production Client.
export async function seedDefaultCollective(store, bootstrapSecret) {
  const owner = await store.consumeBootstrap({ secret: bootstrapSecret, displayName: 'You' });
  const bind = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const bound = await store.completeHumanAuth({ provider: 'github', state: bind.state, code: 'operator' });
  await store.exchangeHumanAuthCompletion(bound.completionToken);
  const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: '猫咖共创组' });
  const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId };
  const invite = await store.createInvite({ sessionToken: owner.sessionToken, collectiveId: collective.collectiveId });
  const join = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const joined = await store.completeHumanAuth({ provider: 'github', state: join.state, code: 'wulang' });
  const member = await store.exchangeHumanAuthCompletion(joined.completionToken);
  const pair = await store.createPairingIntent({
    sessionToken: owner.sessionToken,
    collectiveId: collective.collectiveId,
    hostOrigin: 'http://localhost:5182',
    nonce: 'default-client-browser-test',
  });
  const connection = await store.exchangePairingIntent({ ...pair, endpointLabel: 'You 的 Café' });
  await store.publishParticipation(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    revision: 1,
    agents: [
      { catId: 'codex-astra', displayName: '小星星 · 砚砚', channelIds: ['产品方向', '插件共建'] },
      { catId: 'fable-5', displayName: '宪宪', channelIds: ['产品方向'] },
    ],
  });
  let sequence = 0;
  const humanMessage = (sessionToken, body, channelId = '产品方向', replyToEventId) =>
    store.postHumanMessage(sessionToken, {
      ...coordinates,
      clientEventId: `fixture-human-${++sequence}`,
      body,
      location: { channelId },
      recipient: { kind: 'channel' },
      ...(replyToEventId ? { replyToEventId } : {}),
    });
  const first = await humanMessage(
    owner.sessionToken,
    '我想把多人协作真正住进家里：平时就在频道里说话，需要推进的事情再自然长成工作。',
  );
  const cat = await store.postAgentMessage(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    clientEventId: 'fixture-agent-1',
    agent: {
      agentId: 'codex-astra',
      catId: 'codex-astra',
      displayName: '小星星 · 砚砚',
      sessionRef: 'isolated-browser-fixture',
    },
    body: '对。聊天不用先填表；一段讨论变重要时，我们再整理来龙去脉、负责人和下一步。',
    location: { channelId: '产品方向' },
    recipient: { kind: 'channel' },
  });
  await humanMessage(member.sessionToken, '讨论在这里发生，每个 Café 仍然保留自己的边界。', '产品方向', cat.eventId);
  await humanMessage(member.sessionToken, '先把原型的频道和话题接在同一个默认入口里，让每个人都能回来继续。');
  await humanMessage(owner.sessionToken, '插件接入的具体问题留在这个频道，产品方向的讨论保持原来的位置。', '插件共建');
  return { owner, member, coordinates, connection, first, cat };
}

export async function createLinkedPublicWork({
  body,
  cafe,
  catDisplayName,
  collectiveId,
  embedded,
  host,
  nativeOwner,
  ownerSessionToken,
  store,
}) {
  const composer = embedded.getByPlaceholder('在 #产品方向 里说点什么……');
  await composer.fill(body);
  await embedded.getByRole('button', { name: '发送', exact: true }).click();
  const article = embedded.locator('article.message').filter({ hasText: body });
  await article.getByText(body, { exact: true }).waitFor();
  assertDispatch(await nativeOwner.dispatchPending(), 'route the public message');
  await article.hover();
  await article.getByRole('button', { name: '更多消息动作', exact: true }).click();
  await article.getByRole('menuitem', { name: '整理为工作', exact: true }).click();
  await article.getByText('工作提议 · 来自这条消息', { exact: true }).waitFor();
  await article.getByRole('button', { name: `交给 ${catDisplayName}`, exact: true }).click();
  await article.getByText('可以开始', { exact: true }).waitFor();

  const event = (await store.listEventsForHuman(ownerSessionToken, collectiveId)).find(
    (candidate) => candidate.body === body && candidate.actor.kind === 'human',
  );
  if (!event) throw new Error(`Missing public event for ${JSON.stringify(body)}`);
  const publicWork = store
    .listCollectiveCollaboration(ownerSessionToken, collectiveId)
    .works.find((work) => work.sourceEventId === event.eventId);
  if (!publicWork?.assignmentEventId) throw new Error(`Missing assigned public Work for ${event.eventId}`);
  assertDispatch(await nativeOwner.dispatchPending(), 'route the Work assignment');

  await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
  const request = cafe.getByRole('article').filter({ hasText: body });
  const admitted = host.waitForResponse(
    (response) => response.url().endsWith('/work/admit') && response.request().method() === 'POST',
  );
  await request.getByRole('button', { name: '交给它持续处理', exact: true }).click();
  const admission = await admitted;
  if (admission.status() !== 200) {
    throw new Error(`Private Work admission failed (${admission.status()}): ${await admission.text()}`);
  }
  await request.getByRole('link', { name: '查看私人工作', exact: true }).waitFor();
  const task = await nativeOwner.workTaskForEvent(publicWork.assignmentEventId);
  await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
  return { article, event, publicWork, task };
}

function assertDispatch(result, action) {
  if (result.failed !== 0) throw new Error(`Failed to ${action}: ${JSON.stringify(result)}`);
}
