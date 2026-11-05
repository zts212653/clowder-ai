import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { MessageStore, type StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ContentModificationChatProjection } from '../src/domains/collaborative-content/modification/chat-projection.js';
import {
  acceptance,
  openTask,
  proposal,
  record,
  rejection,
  writeback,
} from './helpers/content-modification-chat-projection-fixture.js';

async function legacyFixture(state: 'candidate' | 'rejected' | 'applied') {
  const messages = new MessageStore();
  const source = record();
  assert.ok(source.progress.sourceMessageId);
  assert.ok(source.progress.task);
  const receiptRef =
    state === 'candidate' ? proposal().receiptRef : state === 'rejected' ? rejection().receiptRef : 'writeback-applied';
  const receipt: ContentModificationReceiptV1 = {
    v: 1,
    requestId: source.requestId,
    sourceMessageId: source.progress.sourceMessageId,
    targetCatId: source.payload.targetCatId,
    taskId: source.progress.task.taskId,
    state,
    receiptRef,
    candidateRef: proposal().proposalRef,
    observedAt: 300,
    followUp: { kind: 'none', reason: 'not_applicable' },
  };
  const idempotencyKey = `f309-chat-receipt:${createHash('sha256')
    .update(JSON.stringify(['f309-chat-receipt-v1', source.ownerUserId, receiptRef, state]))
    .digest('hex')}`;
  // Actual pre-1398 writes used userId=system and no from. The canonical
  // Redis reader projects those old rows to this exact sender identity.
  const old = await messages.appendIdempotent({
    userId: 'system',
    from: { kind: 'system', service: 'system' },
    content: 'Preserved historical receipt.',
    threadId: source.payload.threadId,
    timestamp: 300,
    mentions: [],
    replyTo: source.progress.sourceMessageId,
    idempotencyKey,
    extra: { systemKind: 'content_modification_receipt', contentModificationReceiptV1: receipt },
  });
  return { messages, source, old, receipt };
}

for (const state of ['candidate', 'rejected', 'applied'] as const) {
  test(`restart reuses the legacy system-owned ${state} receipt without rewriting or broadcasting it`, async () => {
    const { messages, source, old } = await legacyFixture(state);
    const before = structuredClone(old.message);
    const errors: unknown[] = [];
    let saves = 0;
    let deliveries = 0;
    const projection = () =>
      new ContentModificationChatProjection({
        messages,
        tasks: { get: async () => openTask() },
        delivery: {
          async deliver() {
            deliveries += 1;
            return { state: 'started', entryId: 'unexpected' };
          },
        },
        onSaved: () => {
          saves += 1;
        },
        onError: (error) => errors.push(error),
      });
    for (let restart = 0; restart < 2; restart += 1) {
      const current = projection();
      const result =
        state === 'candidate'
          ? await current.projectCandidate(source, proposal())
          : state === 'rejected'
            ? await current.projectRejection(source, rejection())
            : await current.projectWriteback(
                source,
                acceptance('writeback-applied'),
                writeback('applied', 'writeback-applied'),
              );
      assert.deepEqual(errors, [], 'the existing old receipt must not become a recovery conflict');
      assert.equal(result?.message.id, old.message.id);
      assert.equal(result?.idempotent, true);
    }
    assert.deepEqual(messages.getByThread(source.payload.threadId), [before]);
    assert.equal(saves, 0);
    assert.equal(deliveries, 0);
  });
}

const invalidBindings: {
  name: string;
  message?: Partial<StoredMessage>;
  receipt?: Partial<ContentModificationReceiptV1>;
}[] = [
  { name: 'another owner', message: { userId: 'another-owner' } },
  { name: 'a Human sender', message: { from: { kind: 'user', userId: 'operator' } } },
  { name: 'an unrelated system service', message: { from: { kind: 'system', service: 'unrelated' } } },
  { name: 'another source', receipt: { sourceMessageId: 'another-source' } },
  { name: 'another Task', receipt: { taskId: 'another-task' } },
  { name: 'another target', receipt: { targetCatId: 'other-cat' } },
  { name: 'a different audience', message: { visibility: 'whisper', whisperTo: [] } },
];

for (const invalid of invalidBindings) {
  test(`legacy receipt lookup refuses ${invalid.name} without appending or waking`, async () => {
    const { messages, source, old, receipt } = await legacyFixture('candidate');
    const conflicting: StoredMessage = {
      ...old.message,
      ...invalid.message,
      extra: {
        systemKind: 'content_modification_receipt',
        contentModificationReceiptV1: { ...receipt, ...invalid.receipt },
      },
    };
    const errors: unknown[] = [];
    let appends = 0;
    let saves = 0;
    let deliveries = 0;
    const projection = new ContentModificationChatProjection({
      messages: {
        // Model a malformed legacy index result while keeping the current
        // owner lookup and all actual append behavior in the real store.
        getByIdempotencyKey: (userId, threadId, key) =>
          userId === 'system' ? conflicting : messages.getByIdempotencyKey(userId, threadId, key),
        appendIdempotent: async (input) => {
          appends += 1;
          return messages.appendIdempotent(input);
        },
      },
      tasks: { get: async () => openTask() },
      delivery: {
        async deliver() {
          deliveries += 1;
          return { state: 'started', entryId: 'unexpected' };
        },
      },
      onSaved: () => {
        saves += 1;
      },
      onError: (error) => errors.push(error),
    });
    assert.equal(await projection.projectCandidate(source, proposal()), undefined);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /idempotency conflict/);
    assert.equal(appends, 0);
    assert.equal(saves, 0);
    assert.equal(deliveries, 0);
    assert.deepEqual(messages.getByThread(source.payload.threadId), [old.message]);
  });
}
