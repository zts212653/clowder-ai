import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { withInvocationCredentials } from '../../mcp-server/src/tools/invocation-auth.js';
import {
  handleLiveMeetingAttach,
  handleLiveMeetingSources,
  handleLiveMeetingStart,
  handleLiveMeetingStatus,
  handleLiveMeetingStop,
} from '../../mcp-server/src/tools/live-meeting-tools.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { audioProxyRoutes } from '../src/routes/audio-proxy.js';
import { f317LiveMeetingControlRoutes } from '../src/routes/f317-live-meeting-control.js';
import { createF317MeetingControlBundle } from '../src/routes/f317-meeting-control-bundle.js';
import { f317MeetingShareRoutes } from '../src/routes/f317-meeting-share.js';

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const savedFetch = globalThis.fetch,
    savedUrl = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3199'; // intercepted: no listening socket or external traffic
  const app = Fastify(),
    registry = new InvocationRegistry(),
    threads = new ThreadStore(),
    messages = new MessageStore();
  const thread = await threads.create('default-user');
  const credentials = await registry.create('default-user', 'codex61-sol', thread.id);
  const scope = {
    invocationId: credentials.invocationId,
    userId: 'default-user',
    threadId: thread.id,
    catId: 'codex61-sol' as const,
    callId: 'call-1',
    generation: 1,
  };
  const append = (text: string) =>
    messages.append({
      from: { kind: 'user', userId: scope.userId },
      userId: scope.userId,
      threadId: thread.id,
      content: text,
      mentions: [],
      timestamp: Date.now(),
      extra: {
        liveCompanion: {
          callId: scope.callId,
          modality: 'typed',
          role: 'user',
          clientMessageId: `input-${messages.getByThread(thread.id).length}`,
        },
      },
    });
  const voice = {
    currentSignal: () => new AbortController().signal,
    currentEpoch: () => 0,
    availableForAction: () => true,
    inspectUtterance: async () => null,
  };
  const call = {
    id: scope.callId,
    finished: new Promise<void>(() => {}),
    householdToolsEnabled: true,
    contextScope: (p: { invocationId: string; catId: string; threadId: string }) =>
      p.invocationId === scope.invocationId && p.catId === scope.catId && p.threadId === thread.id ? scope : null,
    acceptsInput: () => true,
    hasCurrentCompanion: async () => true,
    exposureReason: () => 'same_live_call_exposure' as const,
    boundaryContexts: { ownerVoice: voice },
  } as unknown as LiveCompanionCall;
  let grantId: string | undefined, verify: (() => Promise<boolean>) | undefined;
  const host = {
    observeCall: async () => ({ ...scope, state: 'talking' as const }),
    get: () => call,
    attach: async (grant: { grantId: string }, check: () => Promise<boolean>) => {
      grantId = grant.grantId;
      verify = check;
    },
    detach: async () => {
      grantId = undefined;
    },
    isAttached: (grant: { grantId: string }) => grantId === grant.grantId,
  };
  let capture = {
    running: false,
    lifecycle_state: 'stopped',
    controller_lease: null as Record<string, unknown> | null,
    controller_id: '',
    paused: false,
    thread_id: '',
    meeting_id: '',
    started_at: 0,
    chunk_count: 0,
    inputs: [] as Array<Record<string, unknown>>,
    health: { asr: { state: 'ready' } },
  };
  const effects: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let stopReadFailures = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/api/')) {
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: path,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string,
      });
      return new Response(response.payload, { status: response.statusCode });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (path === '/sources')
      return Response.json({
        apps: [{ id: 'com.google.Chrome#pid=42', name: 'Google Chrome' }],
        mics: [{ index: 0, name: 'never exposed' }],
      });
    if (path === '/status') {
      if (!capture.running && capture.started_at > 0 && stopReadFailures-- > 0)
        return Response.json({ error: 'temporary status outage' }, { status: 503 });
      return Response.json(capture);
    }
    effects.push({ path, ...(body ? { body } : {}) });
    if (path === '/start') {
      capture = {
        ...capture,
        running: true,
        lifecycle_state: 'running',
        controller_lease: { expired: false },
        controller_id: String(body?.controller_id),
        thread_id: String(body?.thread_id),
        meeting_id: String(body?.meeting_id),
        started_at: 100,
        inputs: (body?.inputs as Array<Record<string, unknown>>).map((i) => ({
          ...i,
          state: 'running',
          signal: { state: 'silent', pcm_bytes: 96000, peak_abs: 0 },
        })),
      };
      return Response.json({ lease_token: 'fixture-sidecar-private-token', status: capture });
    }
    if (path === '/stop') {
      assert.equal(await verify?.(), false, 'grant must be revoked before stop and late ASR writes');
      assert.equal(body?.lease_token, 'fixture-sidecar-private-token');
      capture = { ...capture, running: false, lifecycle_state: 'stopped', controller_lease: null };
      return Response.json({ summary: { chunks: 0, duration_s: 2 }, status: capture });
    }
    throw new Error(`Unexpected network path ${path}`);
  };
  await app.register(audioProxyRoutes);
  const bundle = createF317MeetingControlBundle(app, {
    ownerUserId: scope.userId,
    sessions: host,
    messages,
    threadStore: threads,
    isCurrentThread: async (u, id) => u === scope.userId && id === thread.id,
  });
  await app.register(f317MeetingShareRoutes, {
    ownerUserId: scope.userId,
    host,
    threadStore: threads,
    service: bundle.share,
  });
  await app.register(f317LiveMeetingControlRoutes, { registry, service: bundle.service });
  await app.ready();
  t.after(async () => {
    try {
      await app.close();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedUrl === undefined) delete process.env.CAT_CAFE_API_URL;
      else process.env.CAT_CAFE_API_URL = savedUrl;
    }
  });
  const run = <T>(fn: () => T) => withInvocationCredentials(credentials, fn);
  return {
    app,
    append,
    run,
    effects,
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    captureThreadId: thread.id,
    getCapture: () => capture,
    endInput: () => {
      capture = { ...capture, running: false, lifecycle_state: 'stopped', controller_lease: null };
    },
    failStopReadbacks: (count: number) => {
      stopReadFailures = count;
    },
  };
}

test('actual MCP transport → callback auth → owner evidence → F195 controller → private share → stop without media', async (t) => {
  const f = await fixture(t);
  const read = (result: { content: Array<{ text?: string }> }) => {
    const text = result.content[0]?.text;
    assert.ok(typeof text === 'string');
    return JSON.parse(text);
  };
  const sources = await f.run(() => handleLiveMeetingSources());
  assert.equal(read(sources).apps[0].id, 'com.google.Chrome#pid=42');
  assert.equal(read(sources).mics, undefined);
  assert.doesNotMatch(JSON.stringify(sources), /never exposed/);
  const request = f.append('开始听 Chrome');
  const start = await f.run(() =>
    handleLiveMeetingStart({ requestMessageId: request.id, sourceId: 'com.google.Chrome#pid=42' }),
  );
  assert.equal(start.isError, undefined, JSON.stringify(start));
  assert.equal(read(start).sharing, true);
  assert.deepEqual(f.effects[0].body?.inputs, [
    { id: 'primary', source: 'app', app_name: 'com.google.Chrome#pid=42', label: 'Google Chrome' },
  ]);
  assert.doesNotMatch(JSON.stringify(start), /fixture-sidecar-private-token|lease_token/);
  const status = read(await f.run(() => handleLiveMeetingStatus()));
  assert.equal(status.signal.state, 'silent');
  assert.equal(status.chunks, 0);
  const stopRequest = f.append('停止录音');
  const stop = await f.run(() =>
    handleLiveMeetingStop({ requestMessageId: stopRequest.id, meetingId: status.meetingId }),
  );
  assert.equal(read(stop).kind, 'stopped');
  assert.equal(f.getCapture().running, false);
  assert.equal(f.effects.filter((e) => e.path === '/stop').length, 1);
});

test('callback rejects missing/invalid principal and injected authority fields before any capture', async (t) => {
  const f = await fixture(t);
  const noAuth = await f.app.inject({ method: 'POST', url: '/api/callbacks/meeting-start', payload: {} });
  assert.equal(noAuth.statusCode, 401);
  const forged = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/meeting-start',
    headers: f.headers,
    payload: {
      requestMessageId: 'old',
      sourceId: 'Chrome',
      mode: 'start',
      actorUserId: 'owner',
      inputs: [{ source: 'mic' }],
    },
  });
  assert.equal(forged.statusCode, 400);
  const old = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/meeting-start',
    headers: f.headers,
    payload: { requestMessageId: 'old', sourceId: 'Chrome', mode: 'start' },
  });
  assert.equal(old.statusCode, 403);
  assert.deepEqual(f.effects, []);
});

test('runtime shutdown revokes share and leaves canonical controller to finalize the exact owned capture', async (t) => {
  const f = await fixture(t);
  const request = f.append('开始听 Chrome');
  await f.run(() => handleLiveMeetingStart({ requestMessageId: request.id, sourceId: 'com.google.Chrome#pid=42' }));
  await f.app.close();
  assert.equal(f.getCapture().running, false);
  assert.equal(f.effects.filter((e) => e.path === '/stop').length, 1);
});

test('Live can act on current owner speech/text without having to find a MessageStore identifier', async (t) => {
  const f = await fixture(t);
  f.append('开始听 Chrome');
  const start = await f.run(() => handleLiveMeetingStart({ sourceId: 'com.google.Chrome#pid=42' }));
  assert.equal(start.isError, undefined, JSON.stringify(start));
  f.append('停止录音');
  const stop = await f.run(() => handleLiveMeetingStop({}));
  assert.equal(stop.isError, undefined, JSON.stringify(stop));
  assert.equal(f.getCapture().running, false);
});

test('successful controller stop with unavailable readback converges on explicit retry without a second stop', async (t) => {
  const f = await fixture(t);
  f.append('开始听 Chrome');
  await f.run(() => handleLiveMeetingStart({ sourceId: 'com.google.Chrome#pid=42' }));
  f.failStopReadbacks(2);
  f.append('停止录音');
  const first = await f.run(() => handleLiveMeetingStop({}));
  assert.equal(first.isError, undefined, JSON.stringify(first));
  assert.equal(JSON.parse(first.content[0].text).kind, 'unconfirmed');
  assert.equal(f.getCapture().running, false);
  f.append('停止录音');
  const unavailable = await f.run(() => handleLiveMeetingStop({}));
  assert.equal(unavailable.isError, undefined, JSON.stringify(unavailable));
  assert.equal(JSON.parse(unavailable.content[0].text).kind, 'unconfirmed');
  f.append('停止录音');
  const confirmed = await f.run(() => handleLiveMeetingStop({}));
  assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed));
  assert.equal(JSON.parse(confirmed.content[0].text).kind, 'stopped');
  assert.equal(f.effects.filter((e) => e.path === '/stop').length, 1);
});

test('spontaneous input stop reconciles the controller before an immediate new Live recording', async (t) => {
  const f = await fixture(t);
  f.append('开始听 Chrome');
  await f.run(() => handleLiveMeetingStart({ sourceId: 'com.google.Chrome#pid=42' }));
  f.endInput();
  f.append('停止录音');
  const stopped = await f.run(() => handleLiveMeetingStop({}));
  assert.equal(JSON.parse(stopped.content[0].text).kind, 'stopped');
  assert.equal(f.effects.filter((e) => e.path === '/stop').length, 0, 'do not stop an already-ended input');
  f.append('开始听 Chrome');
  const restarted = await f.run(() => handleLiveMeetingStart({ sourceId: 'com.google.Chrome#pid=42' }));
  assert.equal(restarted.isError, undefined, JSON.stringify(restarted));
  assert.equal(f.getCapture().running, true);
  assert.equal(f.effects.filter((e) => e.path === '/start').length, 2);
});

test('an opaque legacy capture ID round-trips through Live attach/status/stop and the real exact controller guard', async (t) => {
  const f = await fixture(t);
  const meetingId = 'meeting:2026-10-09 与 legacy ' + 'x'.repeat(180);
  const started = await f.app.inject({
    method: 'POST',
    url: '/api/audio/start',
    headers: { 'x-cat-cafe-user': 'default-user' },
    payload: {
      thread_id: f.captureThreadId,
      meeting_id: meetingId,
      inputs: [{ id: 'primary', source: 'app', app_name: 'com.google.Chrome#pid=42', label: 'Google Chrome' }],
    },
  });
  assert.equal(started.statusCode, 200, started.payload);
  f.append('接入已有转写 Chrome');
  const attached = await f.run(() => handleLiveMeetingAttach({ sourceId: 'com.google.Chrome#pid=42' }));
  assert.equal(attached.isError, undefined, JSON.stringify(attached));
  const status = await f.run(() => handleLiveMeetingStatus());
  assert.equal(JSON.parse(status.content[0].text).meetingId, meetingId);
  f.append('停止录音');
  const stopped = await f.run(() => handleLiveMeetingStop({ meetingId }));
  assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  assert.equal(JSON.parse(stopped.content[0].text).meetingId, meetingId);
  assert.equal(f.getCapture().running, false);
});
