import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { LiveMeetingAudioError } from '../src/domains/concierge/meeting/live-meeting-audio-error.js';
import { meetingAudioSnapshot } from '../src/domains/concierge/meeting/live-meeting-audio-snapshot.js';
import type { LiveMeetingAudioPort } from '../src/domains/concierge/meeting/live-meeting-control-contract.js';
import { f317MeetingShareRoutes } from '../src/routes/f317-meeting-share.js';
import { createMeetingControlFixture } from './helpers/f317-meeting-control-fixture.js';

test('Live attach rejects missing or non-running lifecycle without granting transcript access', async () => {
  for (const lifecycle of [undefined, 'starting', 'finalizing', 'stopped']) {
    const f = createMeetingControlFixture();
    const capture = meetingAudioSnapshot({
      running: true,
      ...(lifecycle ? { lifecycle_state: lifecycle } : {}),
      controller_lease: null,
      thread_id: 'thread-1',
      meeting_id: 'existing',
      started_at: 100,
      inputs: [
        {
          id: 'primary',
          source: 'app',
          app_name: 'com.google.Chrome#pid=42',
          label: 'Google Chrome',
          state: 'running',
        },
      ],
    });
    assert.ok(capture);
    f.setCapture(capture);
    f.setRequest('接入已有转写 Google Chrome');
    await assert.rejects(
      f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'attach' }),
      /meeting_capture_binding_mismatch/,
    );
    assert.equal(f.share.current(), null);
    assert.deepEqual(f.effects, []);
  }
});

test('UI preview, explicit share and late feed verification require the authoritative running lifecycle', async (t) => {
  const app = Fastify();
  const threads = new ThreadStore();
  const thread = await threads.create('default-user');
  let lifecycle: string | undefined = 'running',
    grantId: string | undefined;
  let verify: (() => Promise<boolean>) | undefined;
  const effects: string[] = [];
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'default-user';
  });
  await app.register(f317MeetingShareRoutes, {
    ownerUserId: 'default-user',
    threadStore: threads,
    host: {
      observeCall: async (userId) => ({
        userId,
        callId: 'call-1',
        threadId: 'live-thread',
        catId: 'codex61-sol',
        generation: 1,
        state: 'talking',
      }),
      attach: async (grant, check) => {
        effects.push('attach');
        grantId = grant.grantId;
        verify = check;
      },
      detach: async () => {
        effects.push('detach');
        grantId = undefined;
      },
      isAttached: (grant) => grantId === grant.grantId,
    },
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          running: true,
          ...(lifecycle ? { lifecycle_state: lifecycle } : {}),
          paused: false,
          thread_id: thread.id,
          meeting_id: 'existing',
          started_at: 100,
          inputs: [{ id: 'primary', source: 'app', label: 'Chrome', state: 'running' }],
        }),
      ),
  });
  t.after(() => app.close());
  const url = '/api/concierge/meeting-share',
    headers = { origin: 'http://localhost:3011' };
  const initial = await app.inject({ method: 'GET', url });
  assert.equal(initial.json().kind, 'available');
  const intent = initial.json().intent;
  for (const phase of [undefined, 'unknown', 'starting', 'finalizing', 'stopped']) {
    lifecycle = phase;
    assert.equal((await app.inject({ method: 'GET', url })).json().kind, 'unavailable', String(phase));
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: intent })).statusCode, 409, String(phase));
    assert.deepEqual(effects, []);
  }
  lifecycle = 'running';
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: intent })).statusCode, 200);
  assert.equal(await verify?.(), true);
  lifecycle = undefined;
  assert.equal(await verify?.(), false);
  assert.deepEqual(effects, ['attach', 'detach']);
});

test('retained startup with no allocated inputs stays unconfirmed until the original capture materializes', async () => {
  let accepted!: Parameters<LiveMeetingAudioPort['start']>[0];
  const f = createMeetingControlFixture({
    beforeStart: async (input) => {
      accepted = input;
      throw new LiveMeetingAudioError(504, 'start', 'caller left during deep health');
    },
  });
  await assert.rejects(f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' }));
  for (const lifecycle of ['starting', 'finalizing', 'unknown'] as const) {
    f.setCapture({
      ...f.getCapture(),
      running: false,
      lifecycle,
      threadId: accepted.threadId,
      meetingId: accepted.meetingId,
      startedAt: 100,
      inputs: [],
    });
    assert.equal((await f.service.status(f.principal)).kind, 'unconfirmed', lifecycle);
    f.setRequest('停止录音');
    assert.equal((await f.service.stop(f.principal)).kind, 'unconfirmed', lifecycle);
    assert.deepEqual(f.effects, ['start']);
    assert.equal(f.share.current(), null);
  }
  f.setCaptureOwner('other-owner');
  await assert.rejects(f.service.status(f.principal), /meeting_capture_owner_mismatch/);
  await assert.rejects(f.service.stop(f.principal), /meeting_capture_owner_mismatch/);
  assert.deepEqual(f.effects, ['start']);
  f.setCaptureOwner('owner');
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    inputs: [
      { id: 'primary', source: 'app', appName: accepted.source.id, label: accepted.source.name, state: 'running' },
    ],
  });
  assert.equal((await f.service.status(f.principal)).kind, 'unconfirmed');
  assert.equal((await f.service.stop(f.principal)).kind, 'stopped');
  assert.deepEqual(f.effects, ['start', 'stop']);
  assert.equal(f.share.current(), null);
});

test('an unallocated failed startup reconciles authoritative stopped without issuing a media command', async () => {
  let accepted!: Parameters<LiveMeetingAudioPort['start']>[0];
  const f = createMeetingControlFixture({
    beforeStart: async (input) => {
      accepted = input;
      throw new LiveMeetingAudioError(504, 'start', 'response outcome unknown');
    },
  });
  await assert.rejects(f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' }));
  f.setCapture({
    ...f.getCapture(),
    lifecycle: 'stopped',
    threadId: accepted.threadId,
    meetingId: accepted.meetingId,
    startedAt: 100,
  });
  assert.equal((await f.service.status(f.principal)).kind, 'stopped');
  f.setRequest('停止录音');
  assert.equal((await f.service.stop(f.principal)).kind, 'stopped');
  assert.deepEqual(f.effects, ['start']);
  assert.equal(f.share.current(), null);
});
