import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.ts';
import { maybeStartOwnerLocalNoteLab } from '../src/domains/concierge/live/host/owner-local-note-lab.ts';
import { OwnerPageActionService } from '../src/domains/concierge/live/host/owner-page-action-service.ts';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.ts';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.ts';
import { f317PageActionRoutes } from '../src/routes/f317-page-action.ts';

const route = '/api/concierge/page-action';
const isolated = {
  enabled: true,
  projectRoot: resolve('../..'),
  apiPort: 3202,
  apiHost: '127.0.0.1',
  memoryStore: true,
  nodeEnv: 'test',
};

test('isolated owner HTTP can inspect, cancel and restore the labeled simulation without media', async (t) => {
  const { startOwnerLocalNoteSimulation } = await import(
    '../src/domains/concierge/live/host/owner-local-note-simulation.ts'
  );
  const previousOwnerId = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previousOwnerId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwnerId;
  });
  const lab = await maybeStartOwnerLocalNoteLab(isolated, 10_000);
  assert.ok(lab);
  const messages = new MessageStore();
  const threadService = new ConciergeThreadService({ threadStore: new ThreadStore() });
  const sessions = new LiveCompanionSessions();
  const service = new OwnerPageActionService({
    ownerUserId: 'owner',
    sessions,
    messages,
    profile: lab.profile,
    connector: lab.connector,
  });
  const simulationInput = {
    isolation: isolated,
    ownerUserId: 'owner',
    sessions,
    service,
    messages,
    threadService,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    apiUrl: 'http://127.0.0.1:3202',
  };
  await assert.rejects(
    startOwnerLocalNoteSimulation({ ...simulationInput, isolation: { ...isolated, enabled: false } }),
    /isolated local note lab/,
  );
  const threadId = await threadService.getOrCreate('owner');
  const realCall = await sessions.prepare({
    binding: { userId: 'owner', threadId, catId: createCatId('codex-astra'), callId: 'existing-real-call' },
    messageStore: messages,
    mcpDistDir: simulationInput.mcpDistDir,
    allowedDirectories: simulationInput.allowedDirectories,
    householdToolsEnabled: false,
    verifyCompanion: async () => true,
    verifyNativeBinding: async () => true,
    publish() {},
  });
  t.after(() => realCall.stop());
  sessions.claim(realCall.id, 'owner', threadId, [createCatId('codex-astra')]);
  await realCall.configure({
    CAT_CAFE_API_URL: simulationInput.apiUrl,
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: threadId,
    CAT_CAFE_CAT_ID: 'codex-astra',
    CAT_CAFE_INVOCATION_ID: 'existing-real-invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
  });
  await realCall.ready('existing-native', {
    submitText: async () => 'fixture-turn',
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await realCall.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'existing-native', realtimeSessionId: 'existing-realtime' },
        });
        await realCall.observe({
          method: 'thread/realtime/sdp',
          params: { threadId: 'existing-native', sdp: 'fixture' },
        });
      }
      return {};
    },
  });
  await realCall.start('fixture');
  assert.equal(realCall.status().state, 'talking');
  const bindCall = t.mock.method(service, 'bindCall');
  await assert.rejects(startOwnerLocalNoteSimulation(simulationInput), /Live call already active/);
  assert.equal(bindCall.mock.callCount(), 0, 'simulation must not bind a ledger over an existing call');
  bindCall.mock.restore();
  assert.equal(sessions.get(realCall.id, 'owner'), realCall);
  assert.equal(realCall.status().state, 'talking', 'simulation rejection must not stop the existing call');
  assert.equal((await sessions.observeCall('owner'))?.callId, realCall.id);
  assert.equal((await messages.getByThread(threadId)).length, 0, 'no synthetic source is written on rejection');
  await realCall.stop();
  let expire;
  const originalTimeout = globalThis.setTimeout;
  const scheduled = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 15 * 60_000) expire = callback;
    return originalTimeout(callback, delay, ...args);
  });
  const simulation = await startOwnerLocalNoteSimulation(simulationInput);
  scheduled.mock.restore();
  assert.equal(typeof expire, 'function', 'the real simulation must schedule its 15-minute expiry');
  const source = await messages.getById(simulation.requestMessageId);
  assert.equal(source?.catId, null);
  assert.equal(source?.threadId, simulation.threadId);
  assert.match(source?.content ?? '', /^【模拟请求/);
  await assert.rejects(
    sessions.prepare({ binding: { userId: 'owner', threadId: simulation.threadId } }),
    /Live call already active/,
  );
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner' });
  await app.register(f317PageActionRoutes, { ownerUserId: 'owner', service });
  t.after(async () => {
    await simulation.stop();
    await app.close();
    await lab.close();
  });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost:5202' };

  const first = await app.inject({ method: 'GET', url: route, headers });
  assert.equal(first.statusCode, 200, first.body);
  const view = first.json();
  assert.equal(view.kind, 'available');
  assert.equal(view.requestMessageId, simulation.requestMessageId);
  assert.match(view.requestText, /模拟/);
  assert.equal(view.pageUrl, lab.url);
  const inspect = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: view.requestMessageId },
  });
  assert.equal(inspect.statusCode, 200, inspect.body);
  const preview = inspect.json().preview;
  assert.equal(preview.pageUrl, lab.url);
  assert.equal(preview.value, 'F317 local trial');
  const cancel = await app.inject({ method: 'DELETE', url: route, headers, payload: { previewId: preview.previewId } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const denied = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: preview.previewId },
  });
  assert.equal(denied.statusCode, 409, denied.body);

  const second = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: view.requestMessageId },
  });
  assert.equal(second.statusCode, 200, second.body);
  const confirmed = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: second.json().preview.previewId },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().forward.status, 'applied');
  assert.equal(confirmed.json().rollback.status, 'applied');
  assert.equal(confirmed.json().status, 'restored');

  assert.equal((await app.inject({ method: 'GET', url: route, headers })).json().kind, 'available');
  const third = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: view.requestMessageId },
  });
  assert.equal(third.statusCode, 200, third.body);
  expire();
  await sessions.get(simulation.callId, 'owner')?.finished;
  const closed = await app.inject({ method: 'GET', url: route, headers });
  assert.deepEqual(closed.json(), { kind: 'unavailable' });
  const stale = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: third.json().preview.previewId },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(sessions.get(simulation.callId, 'owner'), undefined, 'expiry releases the single-call slot');
  await simulation.stop();
  await simulation.stop();

  const restarted = await startOwnerLocalNoteSimulation(simulationInput);
  t.after(() => restarted.stop());
  const pending = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: restarted.requestMessageId },
  });
  assert.equal(pending.statusCode, 200, pending.body);
  await restarted.stop();
  assert.deepEqual((await app.inject({ method: 'GET', url: route, headers })).json(), { kind: 'unavailable' });
  const stopped = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: pending.json().preview.previewId },
  });
  assert.equal(stopped.statusCode, 409, stopped.body);
});
