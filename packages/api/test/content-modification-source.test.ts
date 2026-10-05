import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra, serializeExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.js';
import {
  type ContentModificationRecord,
  modificationRequestId,
} from '../src/domains/collaborative-content/modification/journal.js';
import { persistModificationSource } from '../src/domains/collaborative-content/modification/request-source.js';

test('a confirmed request persists a real human source once, preserves literal intent and keeps refs out of the bubble', async () => {
  const messages = new MessageStore();
  const operationId = randomUUID();
  const record: ContentModificationRecord = {
    requestId: modificationRequestId('operator', operationId),
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    progress: {},
    payload: {
      operationId,
      threadId: 'thread-cover',
      targetCatId: 'codex-astra',
      source: {
        kind: 'publication',
        contentRef: 'media-cover',
        ownerRevision: 1,
        ledgerRef: 'ledger-cover',
        expectedLedgerRevision: 1,
      },
      intent: { body: '请保留猫和背景里的手写文字。' },
    },
  };
  const labels = {
    title: '秋日封面',
    targetName: '小星星',
    threadTitle: '一起完成封面',
    completionRule: 'published-result-ready' as const,
  };
  const append = messages.appendIdempotent.bind(messages);
  let lost = false;
  messages.appendIdempotent = (input) => {
    const committed = append(input);
    if (!lost) {
      lost = true;
      throw new Error('source response lost');
    }
    return committed;
  };
  await assert.rejects(persistModificationSource(messages, record, labels, 1000), /source response lost/);
  const source = await persistModificationSource(messages, record, { ...labels, targetName: '小星星·砚砚' }, 1001);
  assert.equal(messages.getByThread('thread-cover').length, 1);
  assert.equal(source.content, '请保留猫和背景里的手写文字。');
  assert.equal(source.extra?.contentModificationRequestV1?.targetName, '小星星');
  assert.equal(source.extra?.contentModificationRequestV1?.contentTitle, '秋日封面');
  assert.equal(source.catId, null);
  assert.equal(source.source, undefined);
  assert.equal(source.deliveryStatus, undefined, 'source persistence is not dispatch');
  assert.equal(source.extra?.custodyOfferV1, undefined);
  assert.equal(source.extra?.contentModificationRequestV1?.requestId, record.requestId);
  assert.ok(source.extra);
  assert.deepEqual(
    safeParseExtra(serializeExtra(source.extra))?.contentModificationRequestV1,
    source.extra.contentModificationRequestV1,
  );
  assert.doesNotMatch(source.content, /sha256:|media-cover|ledger-cover/);
  source.recall = { recalledBy: 'operator', recalledAt: 1002 };
  await assert.rejects(persistModificationSource(messages, record, labels, 1003), /current user-authored Message/);
});
