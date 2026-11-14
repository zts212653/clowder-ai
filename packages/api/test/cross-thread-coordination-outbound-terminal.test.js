/**
 * F167 Phase R — same-invocation outbound active coordination terminal release
 * (positive roof620 lineage, multi-chain isolation, replay safety, and replyTo chains).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createCoordinationCallbackHarness } from './helpers/coordination-callback-harness.js';

describe('F167 Phase R: same-invocation outbound coordination terminal (positive)', () => {
  let harness;

  beforeEach(async () => {
    harness = await createCoordinationCallbackHarness();
  });

  test('roof620: closes minted outbound B (and independent C) in same invocation while preserving incoming A and replay safety', async () => {
    const { registry, threadStore, invocationQueue, post, threadMessages } = harness;
    const threadA = await threadStore.create('user-1', 'MVX Source A');
    const threadWorker = await threadStore.create('user-1', 'Worker Thread');
    const threadRoofB = await threadStore.create('user-1', 'Roof620 Target B');
    const threadTargetC = await threadStore.create('user-1', 'Target C');
    await threadStore.addParticipants(threadA.id, ['opus']);
    await threadStore.addParticipants(threadWorker.id, ['codex']);
    await threadStore.addParticipants(threadRoofB.id, ['sonnet']);
    await threadStore.addParticipants(threadTargetC.id, ['sonnet']);

    const subjectA = 'artifact:cat-planet/F329/human504-five-donors-and-second-roof-consumption';
    const subjectB = 'file:cat-planet/refs/gen/production-operator-v1/roof620-activation';
    const subjectC = 'file:cat-planet/refs/gen/production-operator-v1/second-lock';

    const authA = await registry.create('user-1', 'opus', threadA.id);
    const inboundARes = await post({
      auth: authA,
      threadId: threadWorker.id,
      content: 'Inbound A handoff',
      targetCat: 'codex',
      coordination: { phase: 'active', subjectRef: subjectA },
      clientMessageId: 'inbound-a',
    });
    assert.equal(inboundARes.statusCode, 200);
    const coordA = inboundARes.json().coordination.id;

    const workerAuth = await registry.create(
      'user-1',
      'codex',
      threadWorker.id,
      undefined,
      inboundARes.json().messageId,
    );
    const claimBRes = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Claim roof620 activation',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: subjectB },
      clientMessageId: 'claim-b',
    });
    assert.equal(claimBRes.statusCode, 200);
    const coordB = claimBRes.json().coordination.id;
    assert.notEqual(coordB, coordA);

    const claimCRes = await post({
      auth: workerAuth,
      threadId: threadTargetC.id,
      content: 'Claim second lock',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: subjectC },
      clientMessageId: 'claim-c',
    });
    assert.equal(claimCRes.statusCode, 200);
    const coordC = claimCRes.json().coordination.id;
    assert.notEqual(coordC, coordA);
    assert.notEqual(coordC, coordB);

    const releaseBRes = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Release roof620 activation',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: subjectB },
      clientMessageId: 'release-b',
    });
    assert.equal(releaseBRes.statusCode, 200, releaseBRes.body);
    assert.equal(releaseBRes.json().status, 'ok');
    assert.deepEqual(releaseBRes.json().coordination, {
      id: coordB,
      phase: 'terminal',
      hop: 1,
      subjectRef: subjectB,
    });

    const queueBeforeReplay = invocationQueue.list(threadRoofB.id, 'user-1').length;
    const msgsBeforeReplay = threadMessages(threadRoofB.id).length;
    const replayBRes = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Release roof620 activation',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: subjectB },
      clientMessageId: 'release-b',
    });
    assert.equal(replayBRes.statusCode, 200, replayBRes.body);
    assert.equal(replayBRes.json().status, 'duplicate');
    assert.equal(replayBRes.json().messageId, releaseBRes.json().messageId);
    assert.deepEqual(replayBRes.json().coordination, releaseBRes.json().coordination);
    assert.equal(threadMessages(threadRoofB.id).length, msgsBeforeReplay);
    assert.equal(invocationQueue.list(threadRoofB.id, 'user-1').length, queueBeforeReplay);

    // Omitted subjectRef on bound C inherits C.subjectRef cleanly.
    const releaseCRes = await post({
      auth: workerAuth,
      threadId: threadTargetC.id,
      content: 'Release second lock',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordC },
      clientMessageId: 'release-c',
    });
    assert.equal(releaseCRes.statusCode, 200, releaseCRes.body);
    assert.deepEqual(releaseCRes.json().coordination, {
      id: coordC,
      phase: 'terminal',
      hop: 1,
      subjectRef: subjectC,
    });

    const releaseARes = await post({
      auth: workerAuth,
      threadId: threadA.id,
      content: 'Complete inbound A',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: coordA, subjectRef: subjectA },
      clientMessageId: 'release-a',
    });
    assert.equal(releaseARes.statusCode, 200, releaseARes.body);
    assert.deepEqual(releaseARes.json().coordination, {
      id: coordA,
      phase: 'terminal',
      hop: 1,
      subjectRef: subjectA,
    });
  });

  test('supports same-thread outbound B, standalone outbound B, normal replyTo parent chain, and outbound B back to incoming-terminal source', async () => {
    const { registry, messageStore, threadStore, post } = harness;
    const threadSource = await threadStore.create('user-1', 'Terminal Source');
    const threadWorker = await threadStore.create('user-1', 'Worker');
    await threadStore.addParticipants(threadSource.id, ['opus']);
    await threadStore.addParticipants(threadWorker.id, ['codex', 'sonnet']);

    const parentInSource = await messageStore.append({
      from: { kind: 'user', userId: 'user-1' },
      userId: 'user-1',
      threadId: threadSource.id,
      content: 'Parent anchor in source thread',
      mentions: [],
      timestamp: Date.now(),
    });

    const standaloneAuth = await registry.create('user-1', 'opus', threadSource.id);
    const standaloneClaim = await post({
      auth: standaloneAuth,
      threadId: threadWorker.id,
      content: 'Standalone claim',
      targetCat: 'codex',
      coordination: { phase: 'active' },
      clientMessageId: 'standalone-claim',
    });
    assert.equal(standaloneClaim.statusCode, 200);
    const standaloneRelease = await post({
      auth: standaloneAuth,
      threadId: threadWorker.id,
      content: 'Standalone release',
      targetCat: 'codex',
      coordination: { phase: 'terminal', id: standaloneClaim.json().coordination.id },
      clientMessageId: 'standalone-release',
    });
    assert.equal(standaloneRelease.statusCode, 200, standaloneRelease.body);
    assert.equal(standaloneRelease.json().coordination.phase, 'terminal');
    assert.equal(standaloneRelease.json().coordination.hop, 1);

    const workerAuth = await registry.create(
      'user-1',
      'codex',
      threadWorker.id,
      undefined,
      standaloneRelease.json().messageId,
    );

    const localClaim = await post({
      auth: workerAuth,
      content: 'Local claim',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:local-work' },
      clientMessageId: 'local-claim',
    });
    assert.equal(localClaim.statusCode, 200);
    const localRelease = await post({
      auth: workerAuth,
      content: 'Local release',
      targetCat: 'sonnet',
      replyTo: localClaim.json().messageId,
      coordination: { phase: 'terminal', id: localClaim.json().coordination.id, subjectRef: 'file:local-work' },
      clientMessageId: 'local-release',
    });
    assert.equal(localRelease.statusCode, 200, localRelease.body);
    assert.equal(localRelease.json().coordination.phase, 'terminal');
    assert.equal(localRelease.json().replyTo, localClaim.json().messageId);

    const crossClaimB = await post({
      auth: workerAuth,
      threadId: threadSource.id,
      content: 'Open B back to source',
      targetCat: 'opus',
      coordination: { phase: 'active', subjectRef: 'file:followup-b' },
      clientMessageId: 'cross-claim-b',
    });
    assert.equal(crossClaimB.statusCode, 200);
    const coordB = crossClaimB.json().coordination.id;

    const crossReleaseB = await post({
      auth: workerAuth,
      threadId: threadSource.id,
      content: 'Close B back to source',
      targetCat: 'opus',
      replyTo: parentInSource.id,
      coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:followup-b' },
      clientMessageId: 'cross-release-b',
    });
    assert.equal(crossReleaseB.statusCode, 200, crossReleaseB.body);
    assert.equal(crossReleaseB.json().coordination.id, coordB);
    assert.equal(crossReleaseB.json().coordination.phase, 'terminal');
    assert.equal(crossReleaseB.json().replyTo, parentInSource.id);
  });
});
