import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { modificationRequestId } from '../src/domains/collaborative-content/modification/journal.ts';
import { persistModificationSource } from '../src/domains/collaborative-content/modification/request-source.ts';

test('production modification writer preserves explicit user identity and immutable scoped source replay', async (t) => {
  const messages = new MessageStore();
  const record = {
    requestId: modificationRequestId('operator', 'operation'),
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: {},
    payload: {
      operationId: 'operation',
      targetCatId: 'codex-astra',
      threadId: 'thread',
      intent: { body: '修改原文' },
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        reviewId: 'review',
        expectedReviewRevision: 1,
        expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
      },
    },
  };
  const labels = { title: '标题', targetName: '猫', threadTitle: '线程', completionRule: 'file-writeback-applied' };
  const source = await persistModificationSource(messages, record, labels, 1);
  assert.deepEqual(source.from, { kind: 'user', userId: 'operator' });
  assert.equal(source.catId, null);
  assert.deepEqual(await persistModificationSource(messages, record, labels, 2), source);
  const original = messages.getByIdempotencyKey.bind(messages);
  for (const [name, altered] of [
    ['owner', { ...source, userId: 'foreign' }],
    ['thread', { ...source, threadId: 'foreign' }],
    ['missing sender', { ...source, from: undefined }],
    ['agent sender', { ...source, from: { kind: 'agent', catId: 'codex-astra' } }],
    ['foreign user sender', { ...source, from: { kind: 'user', userId: 'foreign' } }],
  ])
    await t.test(name, async () => {
      messages.getByIdempotencyKey = () => structuredClone(altered);
      try {
        await assert.rejects(persistModificationSource(messages, record, labels, 3), /operation_reused/);
      } finally {
        messages.getByIdempotencyKey = original;
      }
    });
  assert.deepEqual(messages.getById(source.id), source, 'rejected replay cannot rewrite the original source');
});
