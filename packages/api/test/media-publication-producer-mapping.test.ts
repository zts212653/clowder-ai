import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasUniqueMediaProducerRequest } from '../src/domains/collaborative-content/modification/bindings/media-return-binding.js';
import { modificationMessageRequestId } from '../src/domains/collaborative-content/modification/journal.js';
import { mediaPublicationFixture } from './helpers/media-publication-fixture.js';

test('resolver port: one canonical producer request is distinct from unrelated historical causes', async (t) => {
  const f = await mediaPublicationFixture(t);
  const record = f.request.record;
  const child = { ...f.child, causal: { ...f.child.causal, coveredMessageIds: [f.humanMessage.id, 'unrelated'] } };
  assert.equal(
    await hasUniqueMediaProducerRequest(
      {
        requests: f.store.requests,
        messages: f.messages,
        producer: async (candidate) => (candidate.requestId === record.requestId ? child : undefined),
      },
      record,
      child,
    ),
    true,
  );
});

test('resolver port: two exact producing-child bindings stay ambiguous after one request is cancelled', async (t) => {
  const f = await mediaPublicationFixture(t);
  const record = f.request.record;
  const otherMessageId = 'another-causal-human';
  const other = {
    ...record,
    requestId: modificationMessageRequestId(record.ownerUserId, otherMessageId),
    progress: { ...record.progress, sourceMessageId: otherMessageId },
  };
  const child = { ...f.child, causal: { ...f.child.causal, coveredMessageIds: [f.humanMessage.id, otherMessageId] } };
  const requests = { get: (id: string) => (id === other.requestId ? other : id === record.requestId ? record : null) };
  const producer = async () => child; // This port represents already-verified canonical outbox bindings.
  assert.equal(await hasUniqueMediaProducerRequest({ requests, messages: f.messages, producer }, record, child), false);
  await f.integration.requests.cancel(record.requestId, f.human);
  const cancelled = f.store.requests.get(record.requestId, record.ownerUserId)!;
  assert.ok(cancelled.control);
  other.control = cancelled.control;
  assert.equal(
    await hasUniqueMediaProducerRequest({ requests, messages: f.messages, producer }, record, child),
    false,
    'open-request filtering cannot establish generated-image ownership',
  );
});
