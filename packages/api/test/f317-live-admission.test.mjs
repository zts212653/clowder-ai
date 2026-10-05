import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.ts';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.ts';
import { createOwnerLocalNoteProfile } from '../src/domains/concierge/live/host/owner-local-note-profile.ts';
import { OwnerPageActionService } from '../src/domains/concierge/live/host/owner-page-action-service.ts';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.ts';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.ts';
import { companionDecisionRoutes } from '../src/routes/companion-decision-routes.ts';
import { conciergeLiveRoutes } from '../src/routes/concierge-live.ts';
import { messagesRoutes } from '../src/routes/messages.ts';

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
  const tracker = new InvocationTracker();
  const records = new Map();
  let passedPort;
  let sourceMessage;
  let startupItems;
  let startupPrompt;
  const router = {
    resolveTargetsAndIntent: async () => ({
      targetCats: ['codex'],
      intent: { intent: 'execute', explicit: false },
      hasMentions: true,
    }),
    ackCollectedCursors: async () => {},
    routeExecution: async function* (userId, _content, threadId, messageId, targets, _intent, options) {
      passedPort = options.liveCompanion;
      sourceMessage = await messageStore.getById(messageId);
      await passedPort.configure({
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: userId,
        CAT_CAFE_THREAD_ID: threadId,
        CAT_CAFE_CAT_ID: targets[0],
        CAT_CAFE_INVOCATION_ID: 'own-call',
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
      await passedPort.finished;
      yield { type: 'done', catId: targets[0], isFinal: true, timestamp: Date.now() };
    },
  };
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
    invocationTracker: tracker,
    invocationRecordStore: {
      create: async ({ idempotencyKey }) => {
        records.set(idempotencyKey, { invocationId: idempotencyKey, status: 'running' });
        return { outcome: 'created', invocationId: idempotencyKey };
      },
      get: async (id) => records.get(id),
      update: async (id, patch) => Object.assign(records.get(id), patch),
    },
  });
  await app.register(companionDecisionRoutes, { ownerUserId: 'default-user' });
  await app.register(conciergeLiveRoutes, {
    ownerUserId: 'default-user',
    configStore,
    sessions,
    pageActionOwner,
    threadService: new ConciergeThreadService({ threadStore }),
    messageStore,
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
  const prepared = await app.inject({ method: 'POST', url: '/api/concierge/live', headers, payload });
  assert.equal(prepared.statusCode, 202, prepared.body);
  const status = prepared.json();
  assert.equal(status.catId, 'codex', 'the real native carrier keeps its own principal');
  assert.equal(status.companion.duty.catId, 'opus');
  assert.equal(status.companion.displayName, '宪宪');
  await passedPort.initialized.promise;
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
  assert.throws(() => sessions.claim(status.callId, 'default-user', status.threadId, ['codex']), /mismatch/);
  const duplicate = await app.inject({ method: 'POST', url: '/api/concierge/live', headers, payload });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(passedPort.status().state, 'ready');
  const remembered = messageStore.append({
    userId: 'default-user',
    catId: null,
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
});
