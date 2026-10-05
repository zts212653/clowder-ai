import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { LiveInboxHost } from '../src/domains/concierge/live/host/live-inbox-host.js';
import type { LiveInboxReference } from '../src/domains/concierge/live/inbox/live-inbox-contract.js';

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex-astra'),
  invocationId: 'invocation',
  callId: 'call',
  generation: 1,
};
const reference: LiveInboxReference = {
  messageId: 'message-1',
  queueEntryId: 'queue-1',
  threadId: 'home',
  sourceThreadId: 'source',
  authorCatId: 'codex-sol',
  targetCatId: scope.catId,
  priority: 'normal',
  order: '0001:message-1',
  nextWork: false,
  facts: {
    persisted: true,
    notified: false,
    readByInvocationIds: [],
    readInCurrentContext: false,
    handled: false,
    playback: 'unknown',
  },
};

test('Host inbox yields to the real V3 user transcript before delivery and resumes after done', async () => {
  const delivered: string[] = [];
  let nativeWakes = 0;
  const host = new LiveInboxHost({
    scope,
    source: {
      page: async () => ({ items: [reference], hasMore: false }),
      read: async () => reference,
    },
    wakeNative: () => {
      nativeWakes++;
    },
    deliver: async (batch) => {
      delivered.push(batch.notice);
      assert.deepEqual(
        batch.references.map((item) => item.messageId),
        ['message-1'],
      );
      return 'accepted';
    },
    onSuccessorRequired: async () => assert.fail('current readable body needs no successor'),
  });
  assert.equal(host.hasPendingWake(), true);
  assert.ok(nativeWakes > 0);
  host.observe({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: '我补充一下' } });
  await host.atBoundary('tool_complete');
  assert.equal(delivered.length, 0, 'the first user transcript delta must withhold the notice');
  host.observe({ method: 'thread/realtime/transcript/done', params: { role: 'user', text: '我补充一下' } });
  assert.equal(host.hasPendingWake(), true, 'completion must re-signal the retained source');
  await host.atBoundary('tool_complete');
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0], /secret body/i);
  host.close();
});

test('V3 user transcript aborts an in-flight notice and retains the wake after a busy boundary', async () => {
  let beginFirstDelivery = () => {};
  const firstDeliveryStarted = new Promise<void>((resolve) => {
    beginFirstDelivery = resolve;
  });
  let firstSignal: AbortSignal | undefined;
  let attempts = 0;
  const host = new LiveInboxHost({
    scope,
    source: {
      page: async () => ({ items: [reference], hasMore: false }),
      read: async () => reference,
    },
    wakeNative() {},
    deliver: async (batch) => {
      attempts++;
      if (attempts === 1) {
        firstSignal = batch.signal;
        beginFirstDelivery();
        return new Promise<'accepted'>(() => {});
      }
      return 'accepted';
    },
    onSuccessorRequired: async () => assert.fail('current source is readable'),
  });
  const firstBoundary = host.atBoundary('tool_complete');
  await firstDeliveryStarted;
  host.observe({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: '等等' } });
  assert.equal(firstSignal?.aborted, true, 'the pending delivery must be revoked');
  host.observe({ method: 'thread/realtime/transcript/done', params: { role: 'user', text: '等等' } });
  await host.atBoundary('tool_complete'); // A native wake may arrive before the cancelled boundary unwinds.
  await firstBoundary;
  assert.equal(host.hasPendingWake(), true, 'a busy wake must remain scheduled after cancellation');
  await host.atBoundary('tool_complete');
  assert.equal(attempts, 2, 'the source is retried only after the user finishes');
  host.close();
});

test('assistant, empty, and oversized transcript deltas do not impersonate user speech', async () => {
  let delivered = 0;
  const host = new LiveInboxHost({
    scope,
    source: { page: async () => ({ items: [reference], hasMore: false }), read: async () => reference },
    wakeNative() {},
    deliver: async () => {
      delivered++;
      return 'accepted';
    },
    onSuccessorRequired: async () => assert.fail('current source is readable'),
  });
  host.observe({ method: 'thread/realtime/transcript/delta', params: { role: 'assistant', delta: 'hello' } });
  host.observe({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: '' } });
  host.observe({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: 'x'.repeat(32_001) } });
  await host.atBoundary('tool_complete');
  assert.equal(delivered, 1);
  host.close();
});

test('idle unread next work yields exact Queue references without claiming a provider delivery', async () => {
  const successors: string[] = [];
  const host = new LiveInboxHost({
    scope,
    source: {
      page: async () => ({ items: [{ ...reference, nextWork: true }], hasMore: false }),
      read: async () => ({ ...reference, nextWork: true }),
    },
    wakeNative() {},
    deliver: async () => assert.fail('an unread successor has no current parent full-read path'),
    onSuccessorRequired: async (refs) => successors.push(...refs.map((item) => item.queueEntryId)),
  });
  await host.atBoundary('idle');
  assert.deepEqual(successors, ['queue-1']);
  host.close();
});
