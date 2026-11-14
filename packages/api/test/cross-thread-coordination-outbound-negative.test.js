/**
 * F167 Phase R — strict server-owned outbound terminal binding negative controls.
 * Every unproven, cross-scope, stale, or revoked terminal attempt must fail with
 * HTTP 409 and zero persistence / wake / broadcast / idempotency side effects.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createCoordinationCallbackHarness } from './helpers/coordination-callback-harness.js';

describe('F167 Phase R: outbound coordination terminal negative boundaries', () => {
  let harness;

  beforeEach(async () => {
    harness = await createCoordinationCallbackHarness();
  });

  test('rejects unknown anchor, forged/unpersisted id, cross-invocation/owner/actor/source/target/subject, stale and revoked proofs with 409 and zero side effects', async () => {
    const {
      registry,
      messageStore,
      threadStore,
      invocationQueue,
      socketManager,
      buildCallbackPostMessageIdempotencyKey,
      post,
      threadMessages,
    } = harness;

    const threadA = await threadStore.create('user-1', 'Source A');
    const threadWorker = await threadStore.create('user-1', 'Worker');
    const threadStandalone = await threadStore.create('user-1', 'Standalone Worker');
    const threadOtherSource = await threadStore.create('user-1', 'Other Source');
    const threadTarget = await threadStore.create('user-1', 'Target');
    const threadCanceledTarget = await threadStore.create('user-1', 'Canceled Target');
    const threadWrongTarget = await threadStore.create('user-1', 'Wrong Target');
    const threadOtherOwner = await threadStore.create('user-2', 'Other Owner Target');
    for (const t of [
      threadA,
      threadWorker,
      threadStandalone,
      threadOtherSource,
      threadTarget,
      threadCanceledTarget,
      threadWrongTarget,
    ]) {
      await threadStore.addParticipants(t.id, ['opus', 'codex', 'sonnet']);
    }
    await threadStore.addParticipants(threadOtherOwner.id, ['codex', 'sonnet']);

    const standaloneWorkerAuth = await registry.create('user-1', 'codex', threadStandalone.id);
    const prevWorkerAuth = await registry.create('user-1', 'codex', threadWorker.id);
    const coordFromPrevInv = (
      await post({
        auth: prevWorkerAuth,
        threadId: threadTarget.id,
        content: 'Prev invocation active',
        targetCat: 'sonnet',
        coordination: { phase: 'active', subjectRef: 'file:prev' },
      })
    ).json().coordination.id;

    const otherCatAuth = await registry.create('user-1', 'opus', threadWorker.id);
    const coordFromOtherActor = (
      await post({
        auth: otherCatAuth,
        threadId: threadTarget.id,
        content: 'Other actor active',
        targetCat: 'sonnet',
        coordination: { phase: 'active', subjectRef: 'file:actor' },
      })
    ).json().coordination.id;

    const otherSourceAuth = await registry.create('user-1', 'codex', threadOtherSource.id);
    const coordFromOtherSource = (
      await post({
        auth: otherSourceAuth,
        threadId: threadTarget.id,
        content: 'Other source active',
        targetCat: 'sonnet',
        coordination: { phase: 'active', subjectRef: 'file:source' },
      })
    ).json().coordination.id;

    const otherOwnerAuth = await registry.create('user-2', 'codex', threadOtherOwner.id);
    const coordFromOtherOwner = (
      await post({
        auth: otherOwnerAuth,
        content: 'Other owner active',
        targetCat: 'sonnet',
        coordination: { phase: 'active', subjectRef: 'file:owner' },
      })
    ).json().coordination.id;

    const authA = await registry.create('user-1', 'opus', threadA.id);
    const inboundA = await post({
      auth: authA,
      threadId: threadWorker.id,
      content: 'Trigger A',
      targetCat: 'codex',
      coordination: { phase: 'active', subjectRef: 'subject:a' },
    });
    const workerAuth = await registry.create('user-1', 'codex', threadWorker.id, undefined, inboundA.json().messageId);

    const activeB = await post({
      auth: workerAuth,
      threadId: threadTarget.id,
      content: 'Active B',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:b' },
      clientMessageId: 'claim-b-key',
    });
    const coordB = activeB.json().coordination.id;

    const activeUnbound = await post({
      auth: workerAuth,
      threadId: threadTarget.id,
      content: 'Active Unbound',
      targetCat: 'sonnet',
      coordination: { phase: 'active', id: 'coord-unbound-b' },
    });
    const coordUnbound = activeUnbound.json().coordination.id;

    const activeRecalled = await post({
      auth: workerAuth,
      threadId: threadTarget.id,
      content: 'Active Recalled',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:recalled' },
    });
    const recalledMsg = await messageStore.getById(activeRecalled.json().messageId);
    recalledMsg.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };

    const activeDeleted = await post({
      auth: workerAuth,
      threadId: threadTarget.id,
      content: 'Active Deleted',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:deleted' },
    });
    await messageStore.softDelete(activeDeleted.json().messageId, 'user-1');

    const activeCanceled = await post({
      auth: workerAuth,
      threadId: threadCanceledTarget.id,
      content: 'Active Canceled',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:canceled' },
    });
    const canceledMsg = await messageStore.getById(activeCanceled.json().messageId);
    canceledMsg.deliveryStatus = 'canceled';

    async function assertRejected409(targetThreadId, payload, label, expectedKind = 'coordination_id_conflict') {
      const beforeMsgs = threadMessages(targetThreadId).length;
      const beforeQueue = invocationQueue.list(targetThreadId, 'user-1').length;
      const beforeBroadcasts = socketManager.getBroadcasts().length;
      const key = `reusable-key-${label}`;
      const res = await post({
        auth: payload.auth ?? workerAuth,
        threadId: targetThreadId,
        content: `Attempt ${label}`,
        targetCat: 'sonnet',
        replyTo: payload.replyTo,
        coordination: payload.coordination,
        clientMessageId: key,
      });
      assert.equal(res.statusCode, 409, `${label} expected 409, got ${res.statusCode}: ${res.body}`);
      assert.equal(res.json().kind, expectedKind, `${label} expected ${expectedKind}`);
      assert.equal(threadMessages(targetThreadId).length, beforeMsgs, `${label} must not persist message`);
      assert.equal(
        invocationQueue.list(targetThreadId, 'user-1').length,
        beforeQueue,
        `${label} must not enqueue wake`,
      );
      assert.equal(socketManager.getBroadcasts().length, beforeBroadcasts, `${label} must not broadcast`);
      assert.equal(
        await messageStore.getByIdempotencyKey(
          'user-1',
          targetThreadId,
          buildCallbackPostMessageIdempotencyKey('codex', key),
        ),
        null,
        `${label} must not claim idempotency`,
      );
      const reuseCheck = await post({
        auth: payload.auth ?? workerAuth,
        threadId: targetThreadId,
        content: `Valid after ${label}`,
        targetCat: 'sonnet',
        clientMessageId: key,
      });
      assert.equal(reuseCheck.statusCode, 200, `${label} clientMessageId should remain unclaimed`);
    }

    const negativeCases = [
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: 'coord-forged', subjectRef: 'file:b' } },
        'forged-with-incoming',
      ],
      [
        threadTarget.id,
        { auth: standaloneWorkerAuth, coordination: { phase: 'terminal', id: 'coord-forged-standalone' } },
        'forged-standalone',
      ],
      [
        threadTarget.id,
        { replyTo: 'msg-nonexistent', coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:b' } },
        'unknown-anchor',
      ],
      [
        threadTarget.id,
        {
          replyTo: activeUnbound.json().messageId,
          coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:b' },
        },
        'mismatched-anchor',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: coordFromPrevInv, subjectRef: 'file:prev' } },
        'cross-invocation',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: coordFromOtherActor, subjectRef: 'file:actor' } },
        'cross-actor',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: coordFromOtherSource, subjectRef: 'file:source' } },
        'cross-source',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: coordFromOtherOwner, subjectRef: 'file:owner' } },
        'cross-owner',
      ],
      [threadWrongTarget.id, { coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:b' } }, 'cross-target'],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:wrong' } },
        'cross-subject-bound',
        'coordination_subject_conflict',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: coordUnbound, subjectRef: 'file:invented' } },
        'cross-subject-unbound',
        'coordination_subject_conflict',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: activeRecalled.json().coordination.id, subjectRef: 'file:recalled' } },
        'revoked-recalled',
      ],
      [
        threadTarget.id,
        { coordination: { phase: 'terminal', id: activeDeleted.json().coordination.id, subjectRef: 'file:deleted' } },
        'revoked-deleted',
      ],
      [
        threadCanceledTarget.id,
        { coordination: { phase: 'terminal', id: activeCanceled.json().coordination.id, subjectRef: 'file:canceled' } },
        'revoked-canceled',
      ],
    ];

    for (const [targetId, payload, label, expectedKind] of negativeCases) {
      await assertRejected409(targetId, payload, label, expectedKind);
    }

    const reusedActiveKeyRes = await post({
      auth: workerAuth,
      threadId: threadTarget.id,
      content: 'Attempt close B with claim key',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:b' },
      clientMessageId: 'claim-b-key',
    });
    assert.equal(reusedActiveKeyRes.statusCode, 409, reusedActiveKeyRes.body);
    assert.equal(reusedActiveKeyRes.json().kind, 'coordination_id_conflict');

    const firstCloseB = await post({
      auth: workerAuth,
      threadId: threadTarget.id,
      content: 'Legitimate close B',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:b' },
      clientMessageId: 'close-b-once',
    });
    assert.equal(firstCloseB.statusCode, 200, firstCloseB.body);

    await assertRejected409(
      threadTarget.id,
      { coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:b' } },
      'stale-already-closed',
    );
  });
});
