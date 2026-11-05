import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { custodyHttpFixture } from './collective-custody-http.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

test('real HTTP and two production Connectors transfer the full owner unit and keep the original shared artifact readable', async (t) => {
  const f = await custodyHttpFixture(t);
  assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, 'before-handoff')).status, 200);
  const note = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'note-before-handoff',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: f.source.eventId,
    body: '交接后这条真实批注也要保留。',
  });
  const annotated = await f.invoke(
    f.member.sessionToken,
    'annotate',
    { kind: 'annotate', messageEventId: note.eventId, quote: '共同阅读的真实正文', expectedReviewRevision: 1 },
    'note-before-transfer',
  );
  assert.equal(annotated.status, 200);
  await f.store.publishParticipation(f.targetConnection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.targetConnection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const ask = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'cat-before-handoff',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    replyToEventId: f.source.eventId,
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      connectionId: f.targetConnection.connectionId,
      agentId: 'codex61-sol',
      participationRevision: 1,
    },
    body: '请把这处说明改清楚。',
  });
  const requested = await f.invoke(
    f.member.sessionToken,
    'propose',
    {
      kind: 'request-modification',
      messageEventId: ask.eventId,
      annotationIds: [annotated.value.value.view.review.annotations[0].id],
      expectedReviewRevision: annotated.value.value.view.review.revision,
    },
    'request-before-transfer',
  );
  assert.equal(requested.status, 200);
  const proposal = await f.invoke(
    f.targetConnection.endpointCredential,
    'propose',
    {
      kind: 'respond-modification',
      requestId: requested.value.value.request.requestId,
      operationId: '00000000-0000-4000-8000-000000000039',
      expectedOwnerRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: f.artifact.versions[0].blobDigest,
      edits: [
        {
          start: f.text.indexOf('真实正文'),
          end: f.text.indexOf('真实正文') + 4,
          expectedText: '真实正文',
          replacement: '共享正文',
        },
      ],
      response: '说明已更清楚。',
    },
    'proposal-before-transfer',
    {
      connectionId: f.targetConnection.connectionId,
      requestEventId: ask.eventId,
      catId: 'codex61-sol',
      participationRevision: 1,
    },
  );
  assert.equal(proposal.status, 200, JSON.stringify(proposal));
  const offered = await f.post('custody/offer', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    targetHumanId: f.member.human.humanId,
    expectedCustodyRevision: 1,
    requestId: 'explicit-real-custody-offer',
  });
  assert.equal(offered.status, 201);
  const coordinates = {
    ...f.coordinates,
    connectionId: f.target.connectionId,
    artifactId: f.artifact.artifactId,
    transferId: offered.value.handoffRef,
  };
  await f.drive(() => {
    const state = f.store.readArtifactCustody(f.targetCredential, coordinates);
    return state.state === 'committed' && state.targetFinalized && state.sourceFinalized;
  });
  await f.restartTarget();
  const after = await f.invoke(f.member.sessionToken, 'read', {}, 'after-owner-transfer');
  assert.equal(after.status, 200, JSON.stringify(after));
  assert.equal(after.value.value.text, f.text);
  assert.equal(after.value.value.view.review.reviewId, annotated.value.value.view.review.reviewId);
  assert.deepEqual(after.value.value.view.review.annotations, annotated.value.value.view.review.annotations);
  const described = await f.contentOwner.describe(f.artifact.contentRef);
  assert.ok(described.collectiveScope);
  assert.equal((await f.contentOwner.collectiveCustody.fence.read(f.artifact.contentRef))?.state, 'source_retired');
  const target = f.destination.current;
  assert.equal(
    target.reviews.getByContent(
      'destination-real-local-owner',
      f.artifact.contentRef,
      collectiveContentScopeRef(described.collectiveScope),
    )?.reviewId,
    annotated.value.value.view.review.reviewId,
  );
  assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates).length, 1);
  const selection = {
    requestId: requested.value.value.request.requestId,
    proposalRef: proposal.value.value.proposal.proposalRef,
  };
  const preview = await f.invoke(f.member.sessionToken, 'preview', selection, 'preview-at-destination');
  assert.equal(preview.status, 200);
  const adopted = await f.invoke(f.owner.sessionToken, 'apply', selection, 'adopt-at-destination');
  assert.equal(adopted.status, 200, JSON.stringify(adopted));
  assert.equal(adopted.value.value.receipt.ownerRevision, 2);
  assert.deepEqual(await f.invoke(f.owner.sessionToken, 'apply', selection, 'adopt-at-destination'), adopted);
  assert.equal((await target.owner.listOutbox(f.artifact.contentRef)).length, 2);
  assert.equal((await f.contentOwner.listOutbox(f.artifact.contentRef)).length, 1);
  assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0].versions.at(-1)?.ownerRevision, 2);
  await f.store.revokeConnection({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    connectionId: f.connection.connectionId,
  });
  const latest = await f.invoke(f.member.sessionToken, 'read', {}, 'after-old-cafe-revoke');
  assert.equal(latest.status, 200);
  assert.equal(latest.value.value.text, f.text.replace('真实正文', '共享正文'));
  assert.equal(
    (await f.invoke(f.member.sessionToken, 'history', {}, 'history-at-destination')).value.value.versions.length,
    2,
  );
  for (const path of [
    join(f.root, 'service', 'collective-service.json'),
    join(f.root, 'connector', 'collective-connector.json'),
    join(f.targetDirectory, 'collective-connector.json'),
  ]) {
    const persisted = await readFile(path, 'utf8');
    assert.equal(persisted.includes(f.text), false);
    assert.equal(persisted.includes(Buffer.from(f.text).toString('base64')), false);
  }
});

test('a real unresolved Cat request becomes unavailable at the new owner and cannot accept a late candidate', async (t) => {
  const f = await custodyHttpFixture(t);
  const note = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'pending-note',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: f.source.eventId,
    body: '请解释这里。',
  });
  const annotated = await f.invoke(
    f.member.sessionToken,
    'annotate',
    { kind: 'annotate', messageEventId: note.eventId, quote: '共同阅读的真实正文', expectedReviewRevision: 1 },
    'pending-note',
  );
  assert.equal(annotated.status, 200);
  await f.store.publishParticipation(f.targetConnection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.targetConnection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const ask = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'pending-cat',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    replyToEventId: f.source.eventId,
    body: '请改这处说明。',
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      connectionId: f.targetConnection.connectionId,
      agentId: 'codex61-sol',
      participationRevision: 1,
    },
  });
  const requested = await f.invoke(
    f.member.sessionToken,
    'propose',
    {
      kind: 'request-modification',
      messageEventId: ask.eventId,
      annotationIds: [annotated.value.value.view.review.annotations[0].id],
      expectedReviewRevision: annotated.value.value.view.review.revision,
    },
    'pending-cat',
  );
  assert.equal(requested.status, 200);
  const offered = await f.post('custody/offer', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    targetHumanId: f.member.human.humanId,
    expectedCustodyRevision: 1,
    requestId: 'handoff-with-unresolved-cat',
  });
  const coordinates = {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    transferId: offered.value.handoffRef,
    connectionId: f.target.connectionId,
  };
  await f.drive(() => f.store.readArtifactCustody(f.targetCredential, coordinates).targetFinalized);
  const read = await f.invoke(f.member.sessionToken, 'read', {}, 'pending-after-handoff');
  assert.equal(read.status, 200);
  assert.equal(read.value.value.modifications.requests[0].state, 'unavailable');
  assert.equal(read.value.value.modifications.requests[0].unavailableReason, 'custody_transferred');
  const late = await f.invoke(
    f.targetConnection.endpointCredential,
    'propose',
    {
      kind: 'respond-modification',
      requestId: requested.value.value.request.requestId,
      operationId: '00000000-0000-4000-8000-000000000049',
      expectedOwnerRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: f.artifact.versions[0].blobDigest,
      edits: [
        {
          start: f.text.indexOf('真实正文'),
          end: f.text.indexOf('真实正文') + 4,
          expectedText: '真实正文',
          replacement: '共享正文',
        },
      ],
      response: 'Late computation result.',
    },
    'late-cat',
    {
      connectionId: f.targetConnection.connectionId,
      requestEventId: ask.eventId,
      catId: 'codex61-sol',
      participationRevision: 1,
    },
  );
  assert.ok([403, 409].includes(late.status), JSON.stringify(late));
  assert.equal((await f.destination.current.owner.listOutbox(f.artifact.contentRef)).length, 1);
});
