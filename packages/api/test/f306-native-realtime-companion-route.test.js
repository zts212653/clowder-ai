import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture({
  audioState = { state: 'ready' },
  audioStates,
  enabled = true,
  providerError,
  providerStopError,
} = {}) {
  const [
    { nativeRealtimeCompanionRoutes },
    { ThreadStore },
    { SessionChainStore },
    { MessageStore },
    { AgentRegistry },
  ] = await Promise.all([
    import('../dist/routes/native-realtime-companion-routes.js'),
    import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'),
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
  ]);
  const app = Fastify();
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const backingMessageStore = new MessageStore();
  const appendInputs = [];
  const messageStore = {
    append: async (input) => {
      appendInputs.push(input);
      return backingMessageStore.append(input);
    },
    getByThread: (...args) => backingMessageStore.getByThread(...args),
  };
  const agentRegistry = new AgentRegistry();
  const thread = threadStore.create('owner-1', 'Realtime companion');
  sessionChainStore.create({
    cliSessionId: 'native-1',
    threadId: thread.id,
    catId: 'codex-sol',
    userId: 'owner-1',
  });
  const providerCalls = [];
  const providerClosed = deferred();
  let providerInput;
  let stopCalls = 0;
  agentRegistry.register('codex-sol', {
    async *invoke() {},
    async openNativeRealtimeCompanion(input) {
      if (providerError) throw providerError;
      providerInput = input;
      providerCalls.push(input);
      return {
        runtimeSessionId: 'native-1',
        realtimeSessionId: 'realtime-1',
        version: 'v2',
        closed: providerClosed.promise,
        appendTranscript: async (transcript) => providerCalls.push({ transcript }),
        stop: async () => {
          stopCalls += 1;
          if (providerStopError) throw providerStopError;
          providerClosed.resolve({ reason: 'client-stop' });
        },
      };
    },
  });
  let audioCallbacks;
  let audioCloseCalls = 0;
  const audioClosed = deferred();
  let inspectCount = 0;
  const audioSource = {
    inspect: async () => audioStates?.[Math.min(inspectCount++, audioStates.length - 1)] ?? audioState,
    subscribe: async (_threadId, callbacks) => {
      audioCallbacks = callbacks;
      return {
        closed: audioClosed.promise,
        close: () => {
          audioCloseCalls += 1;
          audioClosed.resolve();
        },
      };
    },
  };
  const published = [];
  await app.register(nativeRealtimeCompanionRoutes, {
    enabled,
    threadStore,
    sessionChainStore,
    messageStore,
    agentRegistry,
    audioSource,
    publishMessage: (_threadId, message) => published.push(message),
  });
  await app.ready();
  return {
    app,
    appendInputs,
    audioCallbacks: () => audioCallbacks,
    audioCloseCalls: () => audioCloseCalls,
    messageStore,
    providerCalls,
    providerInput: () => providerInput,
    published,
    stopCalls: () => stopCalls,
    thread,
  };
}

const ownerHeaders = { 'x-cat-cafe-user': 'owner-1', 'x-cat-id': 'codex-sol' };

function startCompanion(ctx, headers = ownerHeaders, payload = { consumer: 'watch_video', experimental: true }) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/threads/${ctx.thread.id}/realtime-companion/start`,
    headers,
    payload,
  });
}

test('explicit named companion bridges F195 transcript into the exact native session and existing message store', async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.app.close());
  const start = await startCompanion(ctx);
  assert.equal(start.statusCode, 201);
  assert.equal(start.json().status, 'active');
  assert.equal(start.json().consumer, 'watch_video');
  assert.equal(start.json().catId, 'codex-sol');
  assert.equal(typeof start.json().startedAt, 'number');
  assert.equal(ctx.providerCalls[0].sessionId, 'native-1');
  assert.equal(ctx.providerCalls[0].consumer, 'watch_video');

  await ctx.audioCallbacks().onTranscript({
    text: '这段也太神人了',
    observedAt: 123,
    inputId: 'browser',
    inputSource: 'app',
    inputLabel: 'Bilibili',
    speakerLabel: 'Speaker 1',
  });
  assert.deepEqual(ctx.providerCalls[1], {
    transcript: {
      text: '这段也太神人了',
      observedAt: 123,
      inputId: 'browser',
      inputSource: 'app',
      inputLabel: 'Bilibili',
      speakerLabel: 'Speaker 1',
    },
  });

  await ctx.providerInput().onEvent({
    kind: 'assistant_transcript',
    runtimeSessionId: 'native-1',
    realtimeSessionId: 'realtime-1',
    text: '真的，剧情已经飞出地球了。',
    occurredAt: 456,
  });
  const messages = await ctx.messageStore.getByThread(ctx.thread.id, 20, 'owner-1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].catId, 'codex-sol');
  assert.equal(messages[0].content, '真的，剧情已经飞出地球了。');
  assert.match(ctx.appendInputs[0].idempotencyKey, /^realtime:realtime-companion-[0-9a-f-]+:1$/);
  assert.equal(ctx.appendInputs[0].extra.realtimeCompanion.consumer, 'watch_video');
  assert.match(ctx.appendInputs[0].extra.realtimeCompanion.invocationId, /^realtime-companion-[0-9a-f-]+$/);
  assert.equal(ctx.published.length, 1);
  assert.deepEqual(ctx.published[0].extra.realtimeCompanion, ctx.appendInputs[0].extra.realtimeCompanion);

  const duplicate = await startCompanion(ctx, ownerHeaders, { consumer: 'meeting_companion', experimental: true });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().code, 'REALTIME_COMPANION_ALREADY_ACTIVE');

  const stop = await ctx.app.inject({
    method: 'POST',
    url: `/api/threads/${ctx.thread.id}/realtime-companion/stop`,
    headers: ownerHeaders,
  });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.json().status, 'stopped');
  assert.equal(ctx.stopCalls(), 1);
  assert.equal(ctx.audioCloseCalls(), 1);
  await ctx.providerInput().onEvent({
    kind: 'assistant_transcript',
    runtimeSessionId: 'native-1',
    realtimeSessionId: 'realtime-1',
    text: '停止后不应落盘',
    occurredAt: 789,
  });
  assert.equal((await ctx.messageStore.getByThread(ctx.thread.id, 20, 'owner-1')).length, 1);
  const status = await ctx.app.inject({
    method: 'GET',
    url: `/api/threads/${ctx.thread.id}/realtime-companion/status`,
    headers: ownerHeaders,
  });
  assert.deepEqual(status.json(), { status: 'inactive', catId: 'codex-sol' });
});

test('capture switch during startup cannot feed another thread into the native session', async (t) => {
  const ctx = await fixture({
    audioStates: [{ state: 'ready' }, { state: 'thread_mismatch', activeThreadId: 'thread-other' }],
  });
  t.after(() => ctx.app.close());
  const response = await startCompanion(ctx);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'REALTIME_COMPANION_CAPTURE_THREAD_MISMATCH');
  assert.equal(ctx.providerCalls.length, 0);
  assert.equal(ctx.audioCloseCalls(), 1);
});

test('provider errors fail the active companion closed before more output can persist', async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.app.close());
  const start = await startCompanion(ctx, ownerHeaders, { consumer: 'meeting_companion', experimental: true });
  assert.equal(start.statusCode, 201);
  await ctx.providerInput().onEvent({
    kind: 'error',
    runtimeSessionId: 'native-1',
    realtimeSessionId: 'realtime-1',
    message: 'provider failed',
    occurredAt: 700,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.providerInput().onEvent({
    kind: 'assistant_transcript',
    runtimeSessionId: 'native-1',
    realtimeSessionId: 'realtime-1',
    text: 'must not persist',
    occurredAt: 701,
  });
  assert.equal((await ctx.messageStore.getByThread(ctx.thread.id, 20, 'owner-1')).length, 0);
  assert.equal(ctx.stopCalls(), 1);
  assert.equal(ctx.audioCloseCalls(), 1);
  const status = await ctx.app.inject({
    method: 'GET',
    url: `/api/threads/${ctx.thread.id}/realtime-companion/status`,
    headers: ownerHeaders,
  });
  assert.deepEqual(status.json(), { status: 'inactive', catId: 'codex-sol' });
});

test('a bounded provider stop failure still returns and clears active state', async (t) => {
  const ctx = await fixture({
    providerStopError: new Error('authoritative_native_realtime_stop_timeout'),
  });
  t.after(() => ctx.app.close());
  assert.equal((await startCompanion(ctx)).statusCode, 201);

  const stop = await ctx.app.inject({
    method: 'POST',
    url: `/api/threads/${ctx.thread.id}/realtime-companion/stop`,
    headers: ownerHeaders,
  });
  assert.equal(stop.statusCode, 200);
  assert.deepEqual(stop.json(), { status: 'stopped', catId: 'codex-sol' });
  assert.equal(ctx.stopCalls(), 1);
  assert.equal(ctx.audioCloseCalls(), 1);
  const status = await ctx.app.inject({
    method: 'GET',
    url: `/api/threads/${ctx.thread.id}/realtime-companion/status`,
    headers: ownerHeaders,
  });
  assert.deepEqual(status.json(), { status: 'inactive', catId: 'codex-sol' });
});

test('provider startup failure closes the F195 subscription without taking over capture', async (t) => {
  const ctx = await fixture({ providerError: new Error('startup failed') });
  t.after(() => ctx.app.close());
  const response = await startCompanion(ctx, ownerHeaders, { consumer: 'meeting_companion', experimental: true });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'REALTIME_COMPANION_NATIVE_SESSION_UNAVAILABLE');
  assert.equal(ctx.audioCloseCalls(), 1);
  assert.equal(ctx.stopCalls(), 0);
});

for (const signal of ['onStopped', 'onError']) {
  test(`post-start audio ${signal} tears down the provider and clears active state`, async (t) => {
    const ctx = await fixture();
    t.after(() => ctx.app.close());
    const start = await startCompanion(ctx, ownerHeaders, { consumer: 'meeting_companion', experimental: true });
    assert.equal(start.statusCode, 201);

    if (signal === 'onError') await ctx.audioCallbacks().onError(new Error('capture stream failed'));
    else await ctx.audioCallbacks().onStopped();

    assert.equal(ctx.stopCalls(), 1);
    assert.equal(ctx.audioCloseCalls(), 1);
    const status = await ctx.app.inject({
      method: 'GET',
      url: `/api/threads/${ctx.thread.id}/realtime-companion/status`,
      headers: ownerHeaders,
    });
    assert.deepEqual(status.json(), { status: 'inactive', catId: 'codex-sol' });
  });
}

test('route is alpha-only, caller-cat bound, explicit opt-in, and capture-thread fenced', async (t) => {
  const disabled = await fixture({ enabled: false });
  t.after(() => disabled.app.close());
  const disabledResp = await startCompanion(disabled);
  assert.equal(disabledResp.statusCode, 404);

  const ctx = await fixture({ audioState: { state: 'thread_mismatch', activeThreadId: 'other-thread' } });
  t.after(() => ctx.app.close());
  const anonymous = await startCompanion(ctx, { 'x-cat-id': 'codex-sol' });
  assert.equal(anonymous.statusCode, 401);
  const missingCat = await startCompanion(ctx, { 'x-cat-cafe-user': 'owner-1' });
  assert.equal(missingCat.statusCode, 400);
  assert.equal(missingCat.json().code, 'REALTIME_COMPANION_CALLER_CAT_REQUIRED');
  const crossUser = await startCompanion(ctx, { 'x-cat-cafe-user': 'intruder', 'x-cat-id': 'codex-sol' });
  assert.equal(crossUser.statusCode, 403);
  assert.equal(ctx.providerCalls.length, 0);
  const notOptedIn = await startCompanion(ctx, ownerHeaders, { consumer: 'watch_video' });
  assert.equal(notOptedIn.statusCode, 400);
  assert.equal(notOptedIn.json().code, 'REALTIME_COMPANION_EXPERIMENTAL_OPT_IN_REQUIRED');
  const broadConsumer = await startCompanion(ctx, ownerHeaders, {
    consumer: 'arbitrary_raw_host',
    experimental: true,
  });
  assert.equal(broadConsumer.statusCode, 400);
  const mismatch = await startCompanion(ctx, ownerHeaders, { consumer: 'meeting_companion', experimental: true });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().code, 'REALTIME_COMPANION_CAPTURE_THREAD_MISMATCH');
  assert.equal(ctx.providerCalls.length, 0);
});
