import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CollectiveModificationIntent } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';

const intent: CollectiveModificationIntent = {
  ownerUserId: 'real-content-cafe-owner',
  requestingHumanId: 'human-requester',
  source: {
    scopeRef: 'owner-scope:shared',
    serviceInstanceId: 'service-shared',
    collectiveId: 'collective-shared',
    artifactId: 'artifact-shared',
    contentRef: 'collective-content:shared',
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    ledgerRef: 'canonical-review',
    ledgerRevision: 3,
    sourceEventId: 'evt_shared-source-0001',
    requestEventId: 'evt_shared-request-0001',
    location: { channelId: 'general', rootEventId: 'evt_shared-source-0001' },
  },
  target: {
    humanId: 'human-cat-owner',
    catId: 'codex61-sol',
    connectionId: 'connection-target',
    participationRevision: 2,
  },
  instruction: '请把这两处说明得更清楚。',
  annotationIds: ['annotation-one', 'annotation-two'],
};

test('shared text candidates reuse the canonical proposal table and never retain a second source-text snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-owner-proposals-'));
  const path = join(directory, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(path);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const text = '# Guide\nOld text.\n';
  const blobDigest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const record = store.requests.collective.reserve({ ...intent, source: { ...intent.source, blobDigest } });
  const command = {
    requestId: record.requestId,
    operationId: '00000000-0000-4000-8000-000000000001',
    expectedOwnerRevision: 1,
    expectedProposalRevision: 0,
    baseRevision: blobDigest,
    edits: [{ start: text.indexOf('Old'), end: text.indexOf('Old') + 3, expectedText: 'Old', replacement: 'New' }],
    response: '已修改这处说明。',
  };
  const source = {
    scopeRef: intent.source.scopeRef,
    contentRef: intent.source.contentRef,
    ownerRevision: 1,
    blobDigest,
    text,
  };
  const beforeSnapshot = store.requests.collective.list(source.scopeRef, 0, 30).snapshot;
  const first = store.text.respondOwner(command, intent.target.catId, source);
  const proposedSnapshot = store.requests.collective.list(source.scopeRef, 0, 30).snapshot;
  assert.notEqual(proposedSnapshot, beforeSnapshot, 'candidate changes invalidate a whole-scope read snapshot');
  assert.equal(first.baseRevision, blobDigest);
  assert.equal(first.authorCatId, intent.target.catId);
  assert.equal(first.resultRevision, `sha256:${createHash('sha256').update(text.replace('Old', 'New')).digest('hex')}`);
  const prepared = store.requests.collective.get(record.requestId, source.scopeRef);
  assert.equal(prepared?.state, 'proposal_ready');
  assert.deepEqual(store.text.respondOwner(command, intent.target.catId, source), first);
  assert.equal(store.requests.collective.list(source.scopeRef, 0, 30).snapshot, proposedSnapshot);
  assert.equal(store.requests.collective.get(record.requestId, source.scopeRef)?.revision, prepared?.revision);
  assert.equal(store.text.source(record.requestId), null);
  assert.throws(() =>
    store.text.respond({ ...command, expectedTaskRevision: 1, expectedOwnerRevision: undefined }, intent.target.catId),
  );
  assert.throws(() => store.text.respondOwner(command, intent.target.catId, { ...source, text: `${text}changed` }), {
    code: 'source_changed',
  });
  assert.throws(() => store.text.respondOwner(command, 'another-cat', source), { code: 'not_found' });
  assert.throws(() => store.text.respondOwner(command, intent.target.catId, { ...source, scopeRef: 'another-scope' }), {
    code: 'not_found',
  });
  assert.throws(
    () => store.text.respondOwner({ ...command, response: 'different operation' }, intent.target.catId, source),
    { code: 'operation_reused' },
  );
  assert.throws(
    () =>
      store.text.respondOwner(
        { ...command, operationId: '00000000-0000-4000-8000-000000000002' },
        intent.target.catId,
        source,
      ),
    { code: 'proposal_changed' },
  );
  store.close();
  store = new ArtifactReviewStore(path);
  assert.deepEqual(store.text.proposals(record.requestId), [first]);
  assert.equal(store.text.source(record.requestId), null);
});

test('one public shared-work request uses the existing durable F309 journal while private consumers cannot claim it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-modification-journal-'));
  const path = join(directory, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(path);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const record = store.requests.collective.reserve(intent);
  assert.equal(record.ownerUserId, intent.ownerUserId);
  assert.equal(record.state, 'requested');
  assert.deepEqual(store.requests.collective.reserve(intent), record);
  assert.equal(store.requests.get(record.requestId, intent.ownerUserId), null);
  assert.deepEqual(store.requests.pending(), []);
  assert.deepEqual(store.requests.recentForProjection(), []);
  assert.equal(store.requests.acquire(record.requestId, intent.ownerUserId), null);
  assert.equal(store.requests.collective.get(record.requestId, 'another-scope'), null);
  assert.throws(
    () => store.requests.collective.reserve({ ...intent, target: { ...intent.target, catId: 'another-cat' } }),
    { code: 'operation_reused' },
  );
  assert.throws(() =>
    store.requests.collective.reserve({
      ...intent,
      source: { ...intent.source, text: 'must not become a duplicate snapshot' },
    }),
  );
  for (let index = 0; index < 31; index++)
    store.requests.collective.reserve({
      ...intent,
      source: { ...intent.source, requestEventId: `evt_shared-paged-${index}` },
    });
  const firstPage = store.requests.collective.list(intent.source.scopeRef, 0, 30);
  const secondPage = store.requests.collective.list(intent.source.scopeRef, 30, 30);
  assert.equal(firstPage.total, 32);
  assert.equal(firstPage.requests.length, 30);
  assert.equal(secondPage.requests.length, 2);
  assert.equal(secondPage.snapshot, firstPage.snapshot);
  assert.equal(new Set([...firstPage.requests, ...secondPage.requests].map((item) => item.requestId)).size, 32);
  store.close();
  store = new ArtifactReviewStore(path);
  assert.deepEqual(store.requests.collective.get(record.requestId, intent.source.scopeRef), record);
  assert.equal(store.requests.collective.list(intent.source.scopeRef, 0, 30).snapshot, firstPage.snapshot);
});

test('shared adoption is pending until the exact owner receipt, has one winner and survives restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-adoption-cas-'));
  const path = join(directory, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(path);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const text = 'Old text.';
  const baseDigest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const request = store.requests.collective.reserve({
    ...intent,
    source: { ...intent.source, blobDigest: baseDigest },
  });
  const proposal = store.text.respondOwner(
    {
      requestId: request.requestId,
      operationId: '00000000-0000-4000-8000-000000000003',
      expectedOwnerRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: baseDigest,
      edits: [{ start: 0, end: 3, expectedText: 'Old', replacement: 'New' }],
      response: '已改。',
    },
    intent.target.catId,
    {
      scopeRef: intent.source.scopeRef,
      contentRef: intent.source.contentRef,
      ownerRevision: 1,
      blobDigest: baseDigest,
      text,
    },
  );
  const input = {
    scopeRef: intent.source.scopeRef,
    ownerUserId: intent.ownerUserId,
    requestId: request.requestId,
    dispositionId: 'collective-adoption:one',
    actorHumanId: intent.requestingHumanId,
    candidateRef: proposal.proposalRef,
    contentRef: intent.source.contentRef,
    expectedOwnerRevision: 1,
    custodyRevision: 1,
    baseDigest,
    resultDigest: proposal.resultRevision,
    ownerOperationId: 'collective-operation:one',
    requestDigest: `sha256:${'c'.repeat(64)}`,
  };
  const pending = store.acceptances.collective.reserve(input);
  assert.equal(pending.state, 'pending');
  assert.equal('receipt' in pending, false);
  assert.equal(store.acceptances.list(request.requestId, intent.ownerUserId).length, 0);
  assert.deepEqual(store.acceptances.collective.reserve(input), pending);
  assert.throws(() => store.acceptances.collective.reserve({ ...input, actorHumanId: 'another-human' }), {
    code: 'operation_reused',
  });
  assert.throws(
    () =>
      store.acceptances.collective.reserve({
        ...input,
        dispositionId: 'another-adoption',
        ownerOperationId: 'another-operation',
      }),
    { code: 'acceptance_exists' },
  );
  const receipt = {
    receiptId: 'owner-receipt:one',
    contentRef: input.contentRef,
    previousOwnerRevision: 1,
    ownerRevision: 2,
    blobDigest: input.resultDigest,
    actor: { kind: 'human' as const, actorId: input.actorHumanId },
    operationId: input.ownerOperationId,
    outboxSequence: 2,
    operationContext: {
      kind: 'collective-artifact:apply' as const,
      scopeRef: input.scopeRef,
      actorHumanId: input.actorHumanId,
      custodyRevision: 1,
      dispositionId: input.dispositionId,
      requestDigest: input.requestDigest,
    },
  };
  assert.throws(
    () => store.acceptances.collective.complete(input, { ...receipt, blobDigest: intent.source.blobDigest }),
    { code: 'invalid_progress' },
  );
  assert.equal(store.acceptances.collective.reserve(input).state, 'pending');
  // The caller has proved absence under the owner lock; failed attempts remain durable but stop blocking a winner.
  store.acceptances.collective.releaseAbsentEffect(input);
  store.close();
  store = new ArtifactReviewStore(path);
  const retry = {
    ...input,
    dispositionId: 'collective-adoption:other',
    ownerOperationId: 'collective-operation:other',
    actorHumanId: 'another-human',
  };
  assert.equal(store.acceptances.collective.reserve(retry).state, 'pending');
  assert.throws(() => store.acceptances.collective.reserve(input), { code: 'acceptance_exists' });
  store.acceptances.collective.releaseAbsentEffect(retry);
  assert.equal(store.acceptances.collective.reserve(input).state, 'pending');
  const accepted = store.acceptances.collective.complete(input, receipt);
  assert.equal(accepted.state, 'accepted');
  assert.equal(store.requests.collective.get(request.requestId, input.scopeRef)?.state, 'accepted');
  assert.deepEqual(store.acceptances.collective.complete(input, receipt), accepted);
  store.close();
  store = new ArtifactReviewStore(path);
  assert.deepEqual(store.acceptances.collective.reserve(input), accepted);
  assert.equal(store.acceptances.list(request.requestId, intent.ownerUserId).length, 0);
});
