import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LivePresentationObservations } from '../src/domains/concierge/live/live-presentation-observations.js';

test('only a trusted current-call assistant item can be visible; native/message aliases report once', async () => {
  const store = new MessageStore();
  const now = Date.now();
  const observed: string[] = [];
  let current = true;
  const p = new LivePresentationObservations({
    scope: { userId: 'owner', threadId: 'home', catId: 'codex61-sol', callId: 'call' },
    session: () => 'rtc',
    available: () => current,
    verify: async () => current,
    store,
    observed: (_receipt, item) => observed.push(item),
  });
  const receipt = {
    kind: 'presentation.observe' as const,
    event: 'first_text_visible' as const,
    observedAt: now,
    callId: 'call',
    reference: { kind: 'native-item' as const, nativeItemId: 'item' },
  };
  assert.deepEqual(
    await p.observe(receipt),
    { kind: 'error', code: 'unavailable' },
    'unknown items are transient until Host publication',
  );
  p.outward({
    stage: 'first_outward_text',
    callId: 'foreign',
    nativeItemId: 'item',
    observedAt: now,
    eventId: 'foreign',
  });
  assert.deepEqual(await p.observe(receipt), { kind: 'error', code: 'unavailable' });
  p.outward({ stage: 'first_outward_text', callId: 'call', nativeItemId: 'item', observedAt: now, eventId: 'outward' });
  assert.deepEqual(
    await p.observe(receipt),
    { kind: 'ok' },
    'a trusted Host item works before durable transcript completion',
  );
  const message = store.append({
    userId: 'owner',
    threadId: 'home',
    from: { kind: 'agent', catId: createCatId('codex61-sol') },
    mentions: [],
    content: 'Actual answer',
    timestamp: now,
    extra: {
      liveCompanion: {
        modality: 'voice',
        callId: 'call',
        nativeThreadId: 'root',
        realtimeSessionId: 'rtc',
        nativeItemId: 'item',
      },
    },
  });
  assert.deepEqual(
    await p.observe({ ...receipt, reference: { kind: 'message', messageId: message.id } }),
    { kind: 'ok' },
    'aliases are acknowledged idempotently',
  );
  assert.deepEqual(observed, ['item']);
  current = false;
  assert.deepEqual(await p.observe({ ...receipt, reference: { kind: 'native-item', nativeItemId: 'new' } }), {
    kind: 'error',
    code: 'unavailable',
  });
  p.close();
});

test('a foreign message or permission revoked during a read cannot record visibility', async () => {
  const store = new MessageStore();
  let current = true;
  let count = 0;
  const message = store.append({
    userId: 'foreign',
    threadId: 'home',
    from: { kind: 'agent', catId: createCatId('codex61-sol') },
    mentions: [],
    content: 'Foreign',
    timestamp: Date.now(),
    extra: {
      liveCompanion: {
        modality: 'voice',
        callId: 'call',
        nativeThreadId: 'root',
        realtimeSessionId: 'rtc',
        nativeItemId: 'item',
      },
    },
  });
  const deps = {
    scope: { userId: 'owner', threadId: 'home', catId: 'codex61-sol', callId: 'call' },
    session: () => 'rtc',
    available: () => current,
    verify: async () => current,
    store: {
      getById: async (id: string) => {
        const value = store.getById(id);
        current = false;
        return value;
      },
    },
    observed: () => {
      count++;
    },
  };
  const p = new LivePresentationObservations(deps);
  assert.deepEqual(
    await p.observe({
      kind: 'presentation.observe',
      event: 'first_text_visible',
      observedAt: Date.now(),
      callId: 'call',
      reference: { kind: 'message', messageId: message.id },
    }),
    { kind: 'error', code: 'invalid_request' },
  );
  assert.equal(count, 0);
  p.close();
});

test('an owned message cannot record a visible fact if the call is revoked or its session changes during lookup', async () => {
  for (const change of ['revoked', 'session'] as const) {
    const store = new MessageStore();
    let current = true;
    let session = 'rtc';
    let facts = 0;
    const message = store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'agent', catId: createCatId('codex61-sol') },
      mentions: [],
      content: 'Owned answer',
      timestamp: Date.now(),
      extra: {
        liveCompanion: {
          modality: 'voice',
          callId: 'call',
          nativeThreadId: 'root',
          realtimeSessionId: 'rtc',
          nativeItemId: 'item',
        },
      },
    });
    const p = new LivePresentationObservations({
      scope: { userId: 'owner', threadId: 'home', catId: 'codex61-sol', callId: 'call' },
      session: () => session,
      available: () => current,
      verify: async () => current,
      store: {
        getById: async (id) => {
          const result = store.getById(id);
          if (change === 'revoked') current = false;
          else session = 'replacement';
          return result;
        },
      },
      observed: () => {
        facts++;
      },
    });
    assert.deepEqual(
      await p.observe({
        kind: 'presentation.observe',
        event: 'first_text_visible',
        observedAt: Date.now(),
        callId: 'call',
        reference: { kind: 'message', messageId: message.id },
      }),
      { kind: 'error', code: 'unavailable' },
    );
    assert.equal(facts, 0, change);
    p.close();
  }
});
