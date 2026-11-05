import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import {
  CodexLiveTurnInput,
  LIVE_CONTEXT_TRIGGER,
} from '../src/domains/cats/services/agents/providers/CodexLiveTurnInput.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { LiveBoundaryContexts } from '../src/domains/concierge/live/host/live-boundary-contexts.ts';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

const prepared = (input) => ({
  v: 1,
  message: { body: LIVE_CONTEXT_TRIGGER },
  nativeInstructions: [{ body: input.text, injectionDecision: 'app_server_live_context' }],
  runtime: {},
  tools: {},
  providerNativeVisibility: 'unknown',
});

test(
  'a persisted owner-voice wake updates the active native turn without interrupting unrelated work',
  { timeout: 2000 },
  async () => {
    const f = wireFixture({ holdFirstTurn: true });
    let finish;
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    let port;
    let pending = true;
    const client = new CodexAppServerClient({ wire: f.wire });
    try {
      for await (const _event of client.run({
        thread: { kind: 'start' },
        prompt: { kind: 'frozen', prompt: 'synthetic revision call' },
        prepareLiveRequest: prepared,
        live: {
          finished,
          ready: async (_thread, native) => {
            port = native;
            native.wakeBoundary();
          },
          observe: async (message) => {
            if (message.method === 'turn/completed' && !pending) finish();
          },
          hasPendingInboxWake: () => pending,
          hasPendingOwnerVoiceWake: () => pending,
          onSafeBoundary: async () => {
            if (!pending) return;
            await port.submitContextAtBoundary(
              '不用Chrome，改用iPad外放。',
              ['home#stored-owner-voice'],
              'owner_voice_context',
              new AbortController().signal,
              async () => true,
            );
            pending = false;
            f.push(f.completed('first'));
          },
        },
      })) {
        /* Drain the real native notification loop. */
      }
      const steers = f.writes.filter((row) => row.method === 'turn/steer');
      assert.equal(steers.length, 1);
      assert.equal(steers[0].params.expectedTurnId, 'first');
      assert.match(steers[0].params.additionalContext['cat-cafe.live-context'].value, /改用iPad/);
      assert.deepEqual(Object.keys(steers[0].params).sort(), [
        'additionalContext',
        'expectedTurnId',
        'input',
        'threadId',
      ]);
      assert.equal(f.writes.filter((row) => row.method === 'turn/start').length, 1, 'no new task turn');
      assert.equal(
        f.writes.some((row) => row.method === 'turn/interrupt'),
        false,
        'no blanket work cancellation',
      );
    } finally {
      await f.wire.close();
    }
  },
);

test('owner-voice context cannot start a native turn when the carrier is idle', async () => {
  let writes = 0;
  const input = new CodexLiveTurnInput({
    enqueue() {},
    isOpen: () => true,
    prepare: prepared,
    request: async () => {
      writes++;
      return { turn: { id: 'unexpected' } };
    },
  });
  await assert.rejects(
    input.submitContextAtBoundary(
      '改用iPad',
      ['home#source'],
      'owner_voice_context',
      new AbortController().signal,
      async () => true,
      'native',
      null,
    ),
    /active native turn/,
  );
  assert.equal(writes, 0);
});

for (const superseded of [false, true])
  test(`coalesced page receipt remains awake after owner voice ${superseded ? 'cancellation' : 'acceptance'}`, async () => {
    const scope = {
      userId: 'owner',
      threadId: 'home',
      catId: 'codex61-sol',
      callId: 'call',
      invocationId: 'inv',
      generation: 1,
    };
    let wakes = 0;
    const writes = [];
    const store = new MessageStore();
    const row = store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content: '现在结果怎样？',
      timestamp: 1,
      mentions: [],
      extra: { liveCompanion: { callId: 'call', modality: 'voice', role: 'user' } },
    });
    const gate = new LiveContextGate({
      binding: scope,
      acceptsInput: () => true,
      matchesInvocation: (q) => q.invocationId === 'inv',
      householdToolsEnabled: () => true,
      verifyCompanion: async () => true,
      run: (f) => f(),
      client: () => ({
        request: async () => ({}),
        submitText: async () => '',
        submitContextAtBoundary: async (_t, _r, k) => {
          writes.push(k);
          return 'active';
        },
      }),
    });
    const contexts = new LiveBoundaryContexts(
      {
        binding: scope,
        messageStore: store,
        verifyNativeBinding: async () => true,
        publish() {},
        mcpDistDir: 'unused',
        allowedDirectories: ['unused'],
      },
      gate,
      () => wakes++,
      (m) => m.id === row.id,
    );
    contexts.configure({ CAT_CAFE_INVOCATION_ID: 'inv' });
    contexts.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'active' } } });
    contexts.queuePageResult({
      scope,
      text: 'actual durable applied result',
      sourceRefs: ['home#receipt'],
      isCurrent: () => true,
    });
    contexts.noteOwnerVoice(row, undefined, contexts.ownerVoice.currentEpoch());
    if (superseded)
      store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: '不用继续，改回Chrome',
        timestamp: 2,
        mentions: [],
      });
    const prior = wakes;
    await contexts.atBoundary('idle');
    assert.deepEqual(writes, superseded ? [] : ['owner_voice_context']);
    assert.ok(wakes > prior, 'consuming the coalesced wake must re-wake the already-settled page receipt');
    await contexts.atBoundary('idle');
    assert.deepEqual(writes, superseded ? ['page_action_result'] : ['owner_voice_context', 'page_action_result']);
    contexts.close();
    gate.close('stopped');
  });
