import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { ConciergeThreadService } from '../dist/domains/concierge/ConciergeThreadService.js';
import { createOwnerLocalNoteProfile } from '../dist/domains/concierge/live/host/owner-local-note-profile.js';
import { OwnerPageActionService } from '../dist/domains/concierge/live/host/owner-page-action-service.js';
import { LiveCompanionSessions } from '../dist/domains/concierge/live/LiveCompanionSessions.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { companionDecisionRoutes } from '../dist/routes/companion-decision-routes.js';
import { conciergeLiveRoutes } from '../dist/routes/concierge-live.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import './helpers/setup-cat-registry.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.ts';

test('Live surface enters ordinary messages with a real owner session and cannot replace or borrow a call', async (t) => {
  const app = Fastify();
  const sessions = new LiveCompanionSessions();
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const pageActionOwner = new OwnerPageActionService({
    ownerUserId: 'default-user',
    sessions,
    messages: messageStore,
    profile: createOwnerLocalNoteProfile('http://127.0.0.1:5227/'),
    connector: {
      async open() {
        throw new Error('no page opened in admission test');
      },
    },
  });
  const newLedger = pageActionOwner.newLedger.bind(pageActionOwner);
  let actionLedger;
  pageActionOwner.newLedger = () => {
    actionLedger = newLedger();
    return actionLedger;
  };
  const configStore = new MemoryConciergeConfigStore();
  await configStore.put('default-user', {
    ...CONCIERGE_CONFIG_DEFAULTS,
    dutyCatProfileId: 'opus',
    displayName: '宪宪',
  });
  let passedPort;
  let sourceMessage;
  let startupItems;
  let startupPrompt;
  let startupMcpConfig;
  const router = {
    resolveTargetsAndIntent: async () => ({
      targetCats: ['codex'],
      intent: { intent: 'execute', explicit: false },
      hasMentions: true,
    }),
    ackCollectedCursors: async () => {},
    prepareNativeLive: async (userId, threadId, messageId, targets, options) => {
      passedPort = options.liveCompanion;
      sourceMessage = await messageStore.getById(messageId);
      startupMcpConfig = await passedPort.configure({
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: userId,
        CAT_CAFE_THREAD_ID: threadId,
        CAT_CAFE_CAT_ID: targets[0],
        CAT_CAFE_INVOCATION_ID: options.fixtureChildInvocationId,
        CAT_CAFE_EXECUTION_ID: options.parentInvocationId,
        CAT_CAFE_CALLBACK_TOKEN: 'own-token',
      });
      await passedPort.ready('native', {
        submitText: async () => 'unused',
        request: async (method, params) => {
          if (method === 'thread/realtime/start') {
            startupItems = params.initialItems;
            startupPrompt = params.prompt;
            await passedPort.observe({
              method: 'thread/realtime/started',
              params: { threadId: 'native', realtimeSessionId: 'rtc' },
            });
            await passedPort.observe({
              method: 'thread/realtime/sdp',
              params: { threadId: 'native', sdp: 'synthetic-answer' },
            });
          }
          if (method === 'thread/realtime/stop')
            await passedPort.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
          return {};
        },
      });
    },
  };
  const queueFixture = createPersistedQueueFixture(messageStore, {
    liveCompanionSessions: sessions,
    onExecution: (options) =>
      router.prepareNativeLive(
        'default-user',
        messageStore.getById(options.persistedPromptMessageIds[0]).threadId,
        options.persistedPromptMessageIds[0],
        ['codex'],
        {
          ...options,
          fixtureChildInvocationId: messageStore.getById(
            messageStore.getById(options.persistedPromptMessageIds[0]).lifecycle.dispatchRefs[0].statusMessageId,
          ).lifecycle.invocationId,
        },
      ),
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  await app.register(messagesRoutes, {
    registry: { active: () => new Set() },
    messageStore,
    threadStore,
    router,
    liveCompanionSessions: sessions,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    invocationTracker: queueFixture.tracker,
    invocationQueue: queueFixture.queue,
    queueProcessor: queueFixture.processor,
    invocationRecordStore: queueFixture.records,
  });
  await app.register(companionDecisionRoutes, { ownerUserId: 'default-user' });
  await app.register(conciergeLiveRoutes, {
    ownerUserId: 'default-user',
    configStore,
    sessions,
    pageActionOwner,
    threadService: new ConciergeThreadService({ threadStore }),
    messageStore,
    invocationQueue: queueFixture.queue,
    progressOwnedCarrier: (entry, catId) => queueFixture.processor.progressOwnedCarrier(entry, catId),
    sessionChainStore: { getActive: async () => ({ cliSessionId: 'native' }) },
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    publish() {},
  });
  app.get('/api/approval-hub/pending', async (request) => {
    assert.equal(request.headers['x-cat-cafe-user'], 'default-user');
    return { items: [], coverage: { state: 'complete' } };
  });
  app.get('/api/entrusted-work/needs-me', async (request) => {
    assert.equal(request.headers['x-cat-cafe-user'], 'default-user');
    return { ownerReads: [], coverage: { state: 'complete' } };
  });
  t.after(async () => {
    await sessions.close();
    await queueFixture.close();
    await app.close();
  });
  const payload = { allowHomeReads: true };
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/concierge/live',
    headers: { 'x-cat-cafe-user': 'default-user', origin: 'http://localhost:3011' },
    payload,
  });
  assert.equal(anonymous.statusCode, 401);
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost:3011' };
  const ownerIdentity = await app.inject({ method: 'GET', url: '/api/concierge/live/identity', headers });
  assert.equal(ownerIdentity.statusCode, 200);
  assert.equal(ownerIdentity.json().status, 'selected');
  assert.equal(ownerIdentity.json().identity.name, '猫猫球');
  assert.equal(ownerIdentity.json().identity.partner.catId, 'opus');
  assert.equal(ownerIdentity.json().identity.partner.displayName, '宪宪');
  assert.equal(ownerIdentity.json().identity.live.catId, 'codex');
  assert.equal(ownerIdentity.json().identity.live.verifiedModel, null);
  assert.equal((await app.inject({ method: 'GET', url: '/api/concierge/live/identity' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/concierge/live/identity',
        headers,
        remoteAddress: '192.0.2.10',
      })
    ).statusCode,
    403,
  );
  const deniedDecisions = await app.inject({ method: 'GET', url: '/api/concierge/work/decisions' });
  assert.notEqual(deniedDecisions.statusCode, 200);
  const decisions = await app.inject({ method: 'GET', url: '/api/concierge/work/decisions', headers });
  assert.equal(decisions.statusCode, 200);
  assert.equal(decisions.json().status, 'available');
  assert.equal(decisions.json().approvalCount, 0);
  assert.equal(decisions.json().needsMeCount, 0);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/concierge/work/decisions?limit=21', headers })).statusCode,
    400,
  );
  const unsupported = await app.inject({
    method: 'POST',
    url: '/api/concierge/live',
    headers,
    payload: { ...payload, catId: 'opus' },
  });
  assert.equal(unsupported.statusCode, 400, 'the surface cannot supply an execution identity');
  const forgedMeetingAdmission = await app.inject({
    method: 'POST',
    url: '/api/concierge/live',
    headers,
    payload: { ...payload, meetingToolsEnabled: true },
  });
  assert.equal(forgedMeetingAdmission.statusCode, 400, 'meeting exposure is a Host composition option');
  const prepared = await app.inject({ method: 'POST', url: '/api/concierge/live', headers, payload });
  assert.equal(prepared.statusCode, 202, prepared.body);
  const status = prepared.json();
  assert.equal(status.catId, 'codex', 'the real native carrier keeps its own principal');
  assert.equal(status.companion.duty.catId, 'opus');
  assert.equal(status.companion.displayName, '宪宪');
  for (let attempt = 0; !passedPort && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(passedPort, 'actual Queue must start the accepted Live handle');
  await passedPort.initialized.promise;
  const exactChild = await queueFixture.waitForAwakening(sourceMessage.id);
  assert.equal(queueFixture.turns.get(exactChild).queueCompletionPolicy, 'explicit_source');
  assert.equal(
    messageStore.getByThread(status.threadId, 30, 'default-user').filter((m) => m.lifecycle?.kind === 'response')
      .length,
    1,
  );
  assert.deepEqual(
    startupMcpConfig.mcp_servers['cat-cafe-collab'].disabled_tools,
    ['sources', 'start', 'attach', 'status', 'stop'].map((name) => `cat_cafe_meeting_${name}`),
    'ordinary owner admission keeps meeting tools disabled by default',
  );
  const ready = await app.inject({ method: 'GET', url: `/api/concierge/live/${status.callId}`, headers });
  assert.equal(ready.json().state, 'ready');
  const remote = await app.inject({
    method: 'GET',
    url: `/api/concierge/live/${status.callId}`,
    headers,
    remoteAddress: '192.0.2.10',
  });
  assert.equal(remote.statusCode, 403, 'an owner cookie cannot turn remote access into local resource authority');
  assert.equal(sourceMessage.catId, null);
  assert.equal(sourceMessage.threadId, status.threadId);
  assert.equal(actionLedger.isHostAdmissionSource(sourceMessage.id), true);
  assert.equal(sessions.get(status.callId, 'other-owner'), undefined);
  await assert.rejects(sessions.claim(status.callId, 'default-user', status.threadId, ['codex']), /mismatch/);
  const duplicate = await app.inject({ method: 'POST', url: '/api/concierge/live', headers, payload });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(passedPort.status().state, 'ready');
  const remembered = messageStore.append({
    userId: 'default-user',
    from: { kind: 'user', userId: 'default-user' },
    threadId: status.threadId,
    content: '刚才正在讨论合成模型的接缝',
    mentions: [],
    timestamp: Date.now(),
  });
  const started = await app.inject({
    method: 'POST',
    url: `/api/concierge/live/${status.callId}/start`,
    headers,
    payload: { offer: 'synthetic-offer' },
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(
    await passedPort.boundaryContexts.inspectPageActionRequest(sourceMessage.id),
    null,
    'the Host-generated Live admission message cannot become a direct human page-action request',
  );
  assert.match(JSON.stringify(startupItems), new RegExp(remembered.id));
  assert.match(JSON.stringify(startupItems), /合成模型的接缝/);
  assert.match(startupPrompt, /opus/);
  assert.match(startupPrompt, /不能.*冒充/);
  const directText = await app.inject({
    method: 'POST',
    url: `/api/concierge/live/${status.callId}/text`,
    headers,
    payload: { text: '请把本地便签填成固定试验值', clientMessageId: '11111111-1111-4111-8111-111111111111' },
  });
  assert.equal(directText.statusCode, 200, directText.body);
  assert.equal(directText.json().delivery, 'accepted');
  assert.equal(
    (await passedPort.boundaryContexts.inspectPageActionRequest(directText.json().messageId))?.request.sourceRef,
    `${status.threadId}#${directText.json().messageId}`,
    'only a newly accepted direct owner text is eligible for a page action',
  );
  await passedPort.observe({
    method: 'thread/realtime/item/completed',
    params: {
      threadId: 'native',
      item: {
        id: 'spoken',
        realtimeSessionId: 'rtc',
        type: 'transcriptSegment',
        role: 'assistant',
        text: '正在请宪宪核对来源。',
      },
    },
  });
  const spoken = (await messageStore.getByThread(status.threadId, 30, 'default-user')).find(
    (message) => message.content === '正在请宪宪核对来源。',
  );
  assert.equal(spoken.catId, 'codex', 'voice output must never be rewritten as a fabricated opus reply');
  assert.deepEqual(spoken.extra.liveCompanion.identity, ownerIdentity.json().identity);
  const projectedHistory = await app.inject({
    method: 'GET',
    url: `/api/messages?threadId=${status.threadId}&limit=30`,
    headers,
  });
  assert.equal(projectedHistory.statusCode, 200);
  const projectedSpoken = projectedHistory.json().messages.find((message) => message.id === spoken.id);
  assert.deepEqual(projectedSpoken.extra.liveCompanion.identity, ownerIdentity.json().identity);
  await configStore.put('default-user', { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'gemini' });
  assert.deepEqual(spoken.extra.liveCompanion.identity, ownerIdentity.json().identity);
  const changed = await app.inject({ method: 'GET', url: `/api/concierge/live/${status.callId}`, headers });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().code, 'live_selection_changed');
  assert.equal(passedPort.status().state, 'failed', 'selection changes stop old authority instead of rebinding it');
  await assert.rejects(passedPort.finished, /selection changed/);
  await queueFixture.releaseProvider(exactChild, 'failed');
  assert.equal(
    messageStore.getByIdempotencyKey('default-user', status.threadId, `message-lifecycle-response:${exactChild}`)
      .lifecycle.status,
    'failed',
  );
});
