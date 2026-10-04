import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore, type ThreadMessageReadOptions } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LivePageActionApprovalLedger } from '../src/domains/concierge/live/host/live-page-action-approval-ledger.js';
import { LivePageActionAuthority } from '../src/domains/concierge/live/host/live-page-action-authority.js';
import { appendUser, fixture, issueFixtureApproval, scope } from './helpers/f317-page-action-fixture.js';

function timestampOrderedMessages(store: MessageStore) {
  return {
    getById: (id: string) => store.getById(id),
    getByThread: (threadId: string, limit?: number, userId?: string, options?: ThreadMessageReadOptions) =>
      [...store.getByThread(threadId, limit, userId, options)].sort(
        (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
      ),
    getByThreadAfter: (threadId: string, afterId?: string, limit?: number, userId?: string) =>
      store.getByThreadAfter(threadId, afterId, limit, userId),
  };
}

test('a later persisted owner correction supersedes a source despite an older timeline timestamp', async () => {
  const f = fixture();
  const correction = appendUser(
    f.store,
    'Wait, use another note',
    'owner-request-backdated',
    f.source.timestamp - 1_000,
  );
  const messages = timestampOrderedMessages(f.store);
  assert.equal(messages.getByThread(scope.threadId, 256, scope.userId).at(-1)?.id, f.source.id);
  assert.equal(messages.getByThreadAfter(scope.threadId, f.source.id).at(-1)?.id, correction.id);
  const ledger = new LivePageActionApprovalLedger();
  await issueFixtureApproval(ledger, f);
  const authority = new LivePageActionAuthority({
    currentScope: () => scope,
    messages,
    isCurrentThread: async () => true,
    verifyCompanion: async () => true,
    verifyApproval: (input) => ledger.verify(input),
    run: (operation) => operation(),
  });
  await assert.rejects(
    authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port }),
    /Direct owner request unavailable/,
  );
  assert.equal(f.effects(), 0);
  assert.equal(f.closed(), true);
});

test('a later queued owner correction with a backdated timeline score never permits the old action', async () => {
  const f = fixture();
  const entry = new InvocationQueue().enqueue({
    userId: scope.userId,
    threadId: scope.threadId,
    source: 'user',
    ownerAuthProvenance: 'strict',
    content: 'Wait, do something else',
    targetCats: [scope.catId],
    intent: 'coordinate',
  }).entry;
  assert.ok(entry);
  const correction = f.store.append({
    userId: scope.userId,
    threadId: scope.threadId,
    catId: null,
    content: 'Wait, do something else',
    mentions: [scope.catId],
    timestamp: f.source.timestamp - 1_000,
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(entry),
  });
  const messages = timestampOrderedMessages(f.store);
  assert.equal(
    messages.getByThread(scope.threadId, 256, scope.userId, { includeQueuedUserMessages: true }).at(-1)?.id,
    f.source.id,
  );
  assert.deepEqual(messages.getByThreadAfter(scope.threadId, f.source.id), []);
  assert.equal(correction.deliveryStatus, 'queued');
  const ledger = new LivePageActionApprovalLedger();
  await issueFixtureApproval(ledger, f);
  const authority = new LivePageActionAuthority({
    currentScope: () => scope,
    messages,
    isCurrentThread: async () => true,
    verifyCompanion: async () => true,
    verifyApproval: (input) => ledger.verify(input),
    run: (operation) => operation(),
  });
  await assert.rejects(
    authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port }),
    /Direct owner request unavailable/,
  );
  assert.equal(f.closed(), true);
  assert.equal(f.effects(), 0);
});

test('a backdated recalled owner turn cannot leave an older direct action current', async () => {
  const f = fixture();
  const recalled = {
    ...f.source,
    id: 'recalled-owner-correction',
    content: '',
    timestamp: f.source.timestamp - 1_000,
    deliveryStatus: 'canceled' as const,
    _tombstone: true as const,
    recall: { version: 1 as const, exposure: 'seen' as const, recalledAt: Date.now() },
  };
  const base = timestampOrderedMessages(f.store);
  const messages = {
    ...base,
    getByThread: (threadId: string, limit?: number, userId?: string, options?: ThreadMessageReadOptions) =>
      [...base.getByThread(threadId, limit, userId, options), recalled].sort(
        (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
      ),
  };
  assert.equal(messages.getByThread(scope.threadId, 256, scope.userId).at(-1)?.id, f.source.id);
  const ledger = new LivePageActionApprovalLedger();
  await issueFixtureApproval(ledger, f);
  const authority = new LivePageActionAuthority({
    currentScope: () => scope,
    messages,
    isCurrentThread: async () => true,
    verifyCompanion: async () => true,
    verifyApproval: (input) => ledger.verify(input),
    run: (operation) => operation(),
  });
  await assert.rejects(
    authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port }),
    /Direct owner request unavailable/,
  );
  assert.equal(f.closed(), true);
  assert.equal(f.effects(), 0);
});

test('a saturated owner timeline scan refuses to infer that no unseen queued correction exists', async () => {
  const f = fixture();
  for (let i = 0; i < 255; i++)
    f.store.append({
      userId: scope.userId,
      threadId: scope.threadId,
      catId: scope.catId,
      content: `unrelated assistant message ${i}`,
      mentions: [],
      timestamp: Date.now(),
    });
  await assert.rejects(
    f.authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port }),
    /Direct owner request unavailable/,
  );
  assert.equal(f.closed(), true);
  assert.equal(f.effects(), 0);
});
