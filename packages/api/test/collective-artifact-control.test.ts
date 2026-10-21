import assert from 'node:assert/strict';
import { collectiveContentTextProposalReceiptSchema } from '@cat-cafe/shared';
import { sharedProposal } from './collective-artifact-proposal.fixture.js';
import { custodyHttpFixture } from './collective-custody-http.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

for (const action of ['cancel', 'reject'])
  test(`Human ${action} preserves the candidate, creates one durable resolution and prevents adoption after reopen`, async (t) => {
    const f = await custodyHttpFixture(t);
    const selection = await sharedProposal(f);
    const before = await f.invoke(f.member.sessionToken, 'read', {}, 'before-control');
    const record = before.value.value.modifications.requests[0];
    const input = { ...selection, expectedRequestRevision: record.revision };
    if (action === 'reject')
      assert.equal((await f.invoke(f.member.sessionToken, action, input, 'reader-cannot-reject')).status, 403);
    const actor = action === 'cancel' ? f.member : f.owner;
    const resolved = await f.invoke(actor.sessionToken, action, input, 'same-control-operation');
    assert.equal(resolved.status, 200, JSON.stringify(resolved));
    assert.equal(resolved.value.value.request.state, 'cancelled');
    assert.equal(resolved.value.value.request.resolution.kind, action === 'cancel' ? 'cancelled' : 'rejected');
    assert.equal(resolved.value.value.request.resolution.actorHumanId, actor.human.humanId);
    assert.equal(resolved.value.value.request.latestProposalRef, selection.proposalRef);
    await f.restartSource();
    await f.restartService();
    const replay = await f.invoke(actor.sessionToken, action, input, 'same-control-operation');
    assert.deepEqual(replay.value.value, resolved.value.value);
    const preview = await f.invoke(f.member.sessionToken, 'preview', selection, 'retained-candidate');
    assert.equal(preview.status, 200);
    assert.equal(preview.value.value.proposal.proposalRef, selection.proposalRef);
    const agent = {
      connectionId: f.targetConnection.connectionId,
      requestEventId: record.requestEventId,
      catId: 'codex61-sol',
      participationRevision: 1,
    };
    const command = {
      kind: 'respond-modification',
      requestId: selection.requestId,
      operationId: '00000000-0000-4000-8000-000000000081',
      expectedOwnerRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: f.artifact.versions[0].blobDigest,
      edits: preview.value.value.proposal.edits,
      response: preview.value.value.proposal.response,
    };
    const priorProposal = await f.invoke(
      f.targetConnection.endpointCredential,
      'propose',
      command,
      'old-proposal-replay',
      agent,
    );
    assert.equal(priorProposal.status, 200, JSON.stringify(priorProposal));
    assert.deepEqual(
      priorProposal.value.value.proposal,
      collectiveContentTextProposalReceiptSchema.strip().parse(preview.value.value.proposal),
    );
    const lateProposal = await f.invoke(
      f.targetConnection.endpointCredential,
      'propose',
      {
        ...command,
        operationId: '00000000-0000-4000-8000-000000000082',
        expectedProposalRevision: 1,
      },
      'late-new-proposal',
      agent,
    );
    assert.equal(lateProposal.status, 409, JSON.stringify(lateProposal));
    assert.equal((await f.invoke(f.owner.sessionToken, 'apply', selection, 'cannot-adopt-resolved')).status, 409);
    assert.equal((await f.contentOwner.listOutbox(f.artifact.contentRef)).length, 1);
    const offered = await f.post('custody/offer', f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      targetHumanId: f.member.human.humanId,
      expectedCustodyRevision: 1,
      requestId: `transfer-${action}-receipt`,
    });
    assert.equal(offered.status, 201);
    await f.drive(() => {
      const transfer = f.store.readArtifactCustody(f.targetCredential, {
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        connectionId: f.target.connectionId,
        transferId: offered.value.handoffRef,
      });
      return transfer.state === 'committed' && transfer.sourceFinalized && transfer.targetFinalized;
    });
    await f.restartTarget();
    const retained = await f.invoke(f.member.sessionToken, 'read', {}, 'resolution-after-transfer');
    assert.deepEqual(
      retained.value.value.modifications.requests[0].resolution,
      resolved.value.value.request.resolution,
    );
  });

test('an unrelated reader and every Cat are denied request control; two racing Humans cannot cancel committed bytes', async (t) => {
  const f = await custodyHttpFixture(t);
  const selection = await sharedProposal(f, f.owner.sessionToken);
  const before = await f.invoke(f.member.sessionToken, 'read', {}, 'control-auth-source');
  const record = before.value.value.modifications.requests[0];
  const input = { ...selection, expectedRequestRevision: record.revision };
  assert.equal((await f.invoke(f.member.sessionToken, 'cancel', input, 'unrelated-reader')).status, 403);
  for (const action of ['cancel', 'reject'])
    assert.equal(
      (
        await f.invoke(f.targetConnection.endpointCredential, action, input, `cat-${action}`, {
          connectionId: f.targetConnection.connectionId,
          requestEventId: record.requestEventId,
          catId: 'codex61-sol',
          participationRevision: 1,
        })
      ).status,
      403,
    );
  const [cancelled, adopted] = await Promise.all([
    f.invoke(f.owner.sessionToken, 'cancel', input, 'racing-cancel'),
    f.invoke(f.owner.sessionToken, 'apply', selection, 'racing-adopt'),
  ]);
  assert.equal(cancelled.status, 200);
  const receipts = await f.contentOwner.listOutbox(f.artifact.contentRef);
  if (adopted.status === 200) {
    assert.equal(cancelled.value.value.request.state, 'accepted');
    assert.equal(receipts.length, 2);
  } else {
    assert.equal(adopted.status, 409);
    assert.equal(cancelled.value.value.request.state, 'cancelled');
    assert.equal(receipts.length, 1);
  }
});

test('cancellation reconciles an unknown committed adoption before deciding and cannot undo its owner receipt', async (t) => {
  const f = await custodyHttpFixture(t);
  const selection = await sharedProposal(f);
  const before = await f.invoke(f.member.sessionToken, 'read', {}, 'before-lost-adoption');
  const expectedRequestRevision = before.value.value.modifications.requests[0].revision;
  const complete = f.modifications.acceptances.collective.complete;
  f.modifications.acceptances.collective.complete = () => {
    throw new Error('lost disposition completion');
  };
  await f.invoke(f.owner.sessionToken, 'apply', selection, 'original-committed-adoption');
  f.modifications.acceptances.collective.complete = complete;
  assert.equal((await f.contentOwner.describe(f.artifact.contentRef)).currentOwnerRevision, 2);
  await f.restartSource();
  await f.restartService();
  const result = await f.invoke(
    f.member.sessionToken,
    'cancel',
    { ...selection, expectedRequestRevision },
    'cancel-after-unknown-effect',
  );
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.value.value.request.state, 'accepted');
  assert.equal(result.value.value.request.resolution, undefined);
  assert.equal((await f.contentOwner.listOutbox(f.artifact.contentRef)).length, 2);
  const read = await f.invoke(f.member.sessionToken, 'read', {}, 'recover-original-receipt');
  assert.equal(read.status, 200);
  const artifact = f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0];
  assert.equal(artifact.versionCount, 2);
  assert.equal(artifact.versions.length, 1);
  assert.equal(artifact.versions[0].ownerRevision, 2);
});
