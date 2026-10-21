import assert from 'node:assert/strict';
import { sharedProposal } from './collective-artifact-proposal.fixture.js';
import { custodyHttpFixture } from './collective-custody-http.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

test('a new public rework request keeps the old candidate reference and binds the current owner version without moving its old quotes', async (t) => {
  const f = await custodyHttpFixture(t);
  const prior = await sharedProposal(f);
  assert.equal((await f.invoke(f.owner.sessionToken, 'apply', prior, 'adopt-first')).status, 200);
  const current = await f.invoke(f.member.sessionToken, 'read', {}, 'read-before-rework');
  assert.equal(current.status, 200);
  const input = {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    sourceEventId: f.source.eventId,
    ownerRevision: 2,
    annotationIds: [],
    rework: prior,
    expectedReviewRevision: current.value.value.view.review.revision,
    clientEventId: 'explicit-rework-on-new-version',
    body: '基于第2版重做这一处。',
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      connectionId: f.targetConnection.connectionId,
      agentId: 'codex61-sol',
      participationRevision: 1,
    },
  };
  const published = await f.post('requests/publish', f.member.sessionToken, input);
  assert.equal(published.status, 201, JSON.stringify(published));
  const agent = {
    connectionId: f.targetConnection.connectionId,
    requestEventId: published.value.source.eventId,
    catId: 'codex61-sol',
    participationRevision: 1,
  };
  const read = await f.invoke(f.targetConnection.endpointCredential, 'read', {}, 'read-rework', agent);
  assert.equal(read.status, 200, JSON.stringify(read));
  const request = read.value.value.modification;
  assert.equal(read.value.value.ownerRevision, 2);
  assert.equal(request.ownerRevision, 2);
  assert.deepEqual(request.rework, prior);
  assert.equal(request.reworkProposal.proposalRef, prior.proposalRef);
  assert.equal(request.selections[0].anchor.baseRevision, f.artifact.versions[0].blobDigest);
  assert.equal(request.selections[0].ownerRevision, 1, 'the historical quote is explicitly labelled');
  assert.notEqual(request.requestId, prior.requestId);
  await f.restartSource();
  await f.restartService();
  const replay = await f.invoke(f.targetConnection.endpointCredential, 'read', {}, 'read-rework-reopened', agent);
  assert.equal(replay.status, 200, JSON.stringify(replay));
  assert.deepEqual(replay.value.value.modification, request);
  const forged = await f.post('requests/publish', f.member.sessionToken, {
    ...input,
    clientEventId: 'forged-old-candidate',
    rework: { ...prior, proposalRef: 'another-candidate' },
  });
  assert.equal(forged.status, 201, 'Service stores references; only the canonical owner can verify the candidate');
  const bad = await f.invoke(f.targetConnection.endpointCredential, 'read', {}, 'forged-rework-read', {
    ...agent,
    requestEventId: forged.value.source.eventId,
  });
  assert.equal(bad.status, 409);
  assert.equal((await f.contentOwner.describe(f.artifact.contentRef)).currentOwnerRevision, 2);
  const submitted = await f.invoke(
    f.targetConnection.endpointCredential,
    'propose',
    {
      kind: 'respond-modification',
      requestId: request.requestId,
      operationId: '00000000-0000-4000-8000-000000000082',
      expectedOwnerRevision: 2,
      expectedProposalRevision: 0,
      baseRevision: request.blobDigest,
      edits: [
        {
          start: f.text.indexOf('真实正文'),
          end: f.text.indexOf('真实正文') + 4,
          expectedText: '共享正文',
          replacement: '正式正文',
        },
      ],
      response: '基于新正文重新修改。',
    },
    'reworked-proposal',
    agent,
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  const offered = await f.post('custody/offer', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    targetHumanId: f.member.human.humanId,
    expectedCustodyRevision: 1,
    requestId: 'transfer-rework-history',
  });
  assert.equal(offered.status, 201);
  await f.drive(() => {
    const transfer = f.store.readArtifactCustody(f.targetCredential, {
      ...f.coordinates,
      connectionId: f.target.connectionId,
      artifactId: f.artifact.artifactId,
      transferId: offered.value.handoffRef,
    });
    return transfer.state === 'committed' && transfer.targetFinalized && transfer.sourceFinalized;
  });
  await f.restartTarget();
  const selection = { requestId: request.requestId, proposalRef: submitted.value.value.proposal.proposalRef };
  const preview = await f.invoke(f.owner.sessionToken, 'preview', selection, 'preview-rework-at-target');
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.deepEqual(preview.value.value.request.rework, prior);
  const adopted = await f.invoke(f.owner.sessionToken, 'apply', selection, 'adopt-rework-at-target');
  assert.equal(adopted.status, 200, JSON.stringify(adopted));
  assert.equal(adopted.value.value.receipt.ownerRevision, 3);
  assert.deepEqual(await f.invoke(f.owner.sessionToken, 'apply', selection, 'adopt-rework-at-target'), adopted);
  assert.equal((await f.destination.current.owner.listOutbox(f.artifact.contentRef)).length, 3);
  assert.equal((await f.contentOwner.listOutbox(f.artifact.contentRef)).length, 2);
});
