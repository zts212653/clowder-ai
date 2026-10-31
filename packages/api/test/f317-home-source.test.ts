import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore, type StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { readLiveHomeRequest } from '../src/domains/concierge/live/host/home/live-home-request.js';

function fixture(extra?: StoredMessage['extra']) {
  const messages = new MessageStore();
  const source = messages.append({
    userId: 'owner',
    threadId: 'home',
    from: { kind: 'user', userId: 'owner' },
    content: '打开插件设置',
    mentions: [],
    timestamp: Date.now(),
    ...(extra ? { extra } : {}),
  });
  const scope = {
    userId: 'owner',
    threadId: 'home',
    catId: createCatId('codex61-sol'),
    invocationId: 'current-invocation',
    callId: 'current-call',
    generation: 1,
  };
  const controller = new AbortController();
  const input = {
    messages,
    currentScope: () => scope,
    isCurrentThread: async () => true,
    authorize: async () => true,
    available: () => true,
    exposed: () => true,
    voice: { currentSignal: () => controller.signal, currentEpoch: () => 1, inspectUtterance: async () => null },
  };
  return { messages, source, scope, input, controller };
}

test('only a current exposed direct owner source becomes a bounded call-specific request', async () => {
  const f = fixture();
  const request = await readLiveHomeRequest(f.input);
  assert.equal(request?.messageId, f.source.id);
  assert.equal(request?.callId, 'current-call');
  assert.equal(request?.text, f.source.content);
  assert.equal(await readLiveHomeRequest({ ...f.input, exposed: () => false }), null);
  assert.equal(await readLiveHomeRequest({ ...f.input, authorize: async () => false }), null);
  assert.equal(await readLiveHomeRequest({ ...f.input, isCurrentThread: async () => false }), null);
  f.controller.abort();
  assert.equal(request?.signal.aborted, true);
  assert.equal(await readLiveHomeRequest(f.input), null);
});

test('forwarded context, queued new owner input and a changed invocation generation cannot borrow the previous request', async () => {
  const forwarded = fixture({ crossPost: { sourceThreadId: 'other', sourceMessageId: 'cross-source' } });
  assert.equal(await readLiveHomeRequest(forwarded.input), null);
  const f = fixture();
  f.messages.append({
    userId: 'owner',
    threadId: 'home',
    from: { kind: 'user', userId: 'owner' },
    content: '等等',
    mentions: [f.scope.catId],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  assert.equal(await readLiveHomeRequest(f.input), null);
  const g = fixture();
  let reads = 0;
  assert.equal(
    await readLiveHomeRequest({
      ...g.input,
      currentScope: () => (++reads === 1 ? g.scope : { ...g.scope, generation: 2 }),
    }),
    null,
  );
});
