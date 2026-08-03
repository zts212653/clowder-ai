/**
 * F167 Phase T — turn-scoped custody stop-gate projection.
 *
 * The adapter only follows the protocol ball that woke this invocation. Other
 * open work is deliberately absent from the harness.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compareTurnCustodyShadow,
  TurnCustodyProjectionService,
} from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';

function lease(overrides = {}) {
  return {
    leaseId: 'lease-1',
    generation: 3,
    status: 'active',
    holderCatIds: ['codex-sol'],
    holderOutcomes: {},
    completionCandidates: {},
    returnTransitions: [],
    ...overrides,
  };
}

function harness({ currentLease = lease(), projection = { state: 'active', holder: 'codex-sol' }, events = [] } = {}) {
  let activeLease = currentLease;
  const eventLog = [...events];
  let threadProjection = projection;
  const service = new TurnCustodyProjectionService({
    actionSuccessorLeaseStore: {
      async get() {
        return activeLease;
      },
    },
    ballCustodyProjectionStore: {
      async get() {
        return threadProjection;
      },
    },
    ballCustodyEventLog: {
      async read(_subjectKey, fromSequence = 0) {
        return eventLog.slice(fromSequence);
      },
    },
  });
  return {
    service,
    setLease(next) {
      activeLease = next;
    },
    setProjection(next) {
      threadProjection = next;
    },
    addEvent(event) {
      eventLog.push(event);
    },
  };
}

describe('F167 Phase T TurnCustodyProjectionService', () => {
  test('user chat, roam, cron, and protocol decline are covered_empty with zero stop obligation', async () => {
    const { service } = harness();
    for (const source of ['user_chat', 'roam', 'cron', 'protocol_decline']) {
      const opened = await service.open({ kind: 'unstructured', source });
      assert.equal(opened.state, 'covered_empty');
      assert.deepEqual(await service.close(opened), {
        state: 'covered_empty',
        shouldBlock: false,
        transitionObserved: false,
        evidenceRefs: [`wake:${source}`],
      });
    }
  });

  test('machine-proven FYI and coordination clean-stops are covered_empty', async () => {
    const { service } = harness();
    for (const source of ['cross_thread_fyi', 'cross_thread_coordinate', 'coordination_terminal']) {
      const opened = await service.open({ kind: 'non_obligation', source });
      assert.deepEqual(opened, {
        state: 'covered_empty',
        evidenceRefs: [`wake:${source}`],
      });
      assert.equal((await service.close(opened)).shouldBlock, false);
    }
  });

  test('legacy text wake and query failure stay unknown_legacy fail-closed', async () => {
    const { service } = harness();
    const legacy = await service.open({ kind: 'legacy', reason: 'text_mention' });
    assert.equal(legacy.state, 'unknown_legacy');
    assert.equal((await service.close(legacy)).shouldBlock, true);

    const failing = new TurnCustodyProjectionService({
      actionSuccessorLeaseStore: { get: async () => Promise.reject(new Error('redis unavailable')) },
    });
    const unavailable = await failing.open({
      kind: 'action_successor',
      leaseId: 'lease-1',
      generation: 3,
      holderCatId: 'codex-sol',
    });
    assert.equal(unavailable.state, 'unknown_legacy');
    assert.equal((await failing.close(unavailable)).shouldBlock, true);
  });

  test('action successor blocks without a custody transition', async () => {
    const { service } = harness();
    const opened = await service.open({
      kind: 'action_successor',
      leaseId: 'lease-1',
      generation: 3,
      holderCatId: 'codex-sol',
    });
    assert.equal(opened.state, 'covered_active');
    assert.deepEqual(await service.close(opened), {
      state: 'covered_active',
      shouldBlock: true,
      transitionObserved: false,
      evidenceRefs: ['action:lease-1:g3:codex-sol'],
    });
  });

  test('candidate, holder outcome, transfer, and completion are legitimate action transitions', async () => {
    for (const next of [
      lease({ completionCandidates: { 'codex-sol': { candidateRevision: 1, evidenceDigest: 'digest-1' } } }),
      lease({ holderOutcomes: { 'codex-sol': { outcome: 'failed', evidenceRef: 'invocation:1', at: 2 } } }),
      lease({ generation: 4, holderCatIds: ['codex-terra'] }),
      lease({ status: 'completed' }),
    ]) {
      const h = harness();
      const opened = await h.service.open({
        kind: 'action_successor',
        leaseId: 'lease-1',
        generation: 3,
        holderCatId: 'codex-sol',
      });
      h.setLease(next);
      const decision = await h.service.close(opened);
      assert.equal(decision.transitionObserved, true);
      assert.equal(decision.shouldBlock, false);
    }
  });

  test('return transport retries alone do not satisfy the custody transition', async () => {
    const h = harness();
    const opened = await h.service.open({
      kind: 'action_successor',
      leaseId: 'lease-1',
      generation: 3,
      holderCatId: 'codex-sol',
    });
    h.setLease(
      lease({
        returnDeliveryAttemptCount: 2,
        returnDeliveryLastAttemptAt: 5,
        revision: 9,
        updatedAt: 5,
      }),
    );
    assert.equal((await h.service.close(opened)).shouldBlock, true);
  });

  test('structured hold wake ignores invocation.started but accepts hold/transfer/done transitions', async () => {
    const h = harness();
    const opened = await h.service.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
    });
    assert.equal(opened.state, 'covered_active');
    h.addEvent({ kind: 'invocation.started', sourceEventId: 'inv:1:started' });
    assert.equal((await h.service.close(opened)).shouldBlock, true);
    h.addEvent({ kind: 'task.done', sourceEventId: 'task:other-work:done', payload: { taskId: 'other-work' } });
    assert.equal(
      (await h.service.close(opened)).shouldBlock,
      true,
      'TaskStore work items are not protocol-ball progress for this thread hold',
    );
    h.addEvent({
      kind: 'ball.handed',
      sourceEventId: 'route:incoming:codex-sol',
      payload: { fromCatId: 'opus', toCatId: 'codex-sol' },
    });
    assert.equal((await h.service.close(opened)).shouldBlock, true, 'receiving the wake is not turn progress');

    for (const kind of ['ball.held', 'ball.handed', 'ball.handed_cvo']) {
      const next = harness();
      const nextOpened = await next.service.open({
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
      });
      next.addEvent({
        kind,
        sourceEventId: `${kind}:1`,
        payload:
          kind === 'ball.held'
            ? { catId: 'codex-sol' }
            : kind === 'ball.handed' || kind === 'ball.handed_cvo'
              ? { fromCatId: 'codex-sol' }
              : {},
      });
      const decision = await next.service.close(nextOpened);
      assert.equal(decision.shouldBlock, false, kind);
      assert.equal(decision.transitionObserved, true, kind);
    }
  });

  test('structured wake with a different or missing holder stays unknown_legacy', async () => {
    for (const projection of [
      { state: 'active', holder: 'codex-terra' },
      { state: 'blocked', holder: null },
    ]) {
      const { service } = harness({ projection });
      const opened = await service.open({
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
      });
      assert.equal(opened.state, 'unknown_legacy');
      assert.equal((await service.close(opened)).shouldBlock, true);
    }
  });

  test('unknown projections preserve bounded machine-readable failure reasons', async () => {
    const actionMissing = new TurnCustodyProjectionService({
      actionSuccessorLeaseStore: { get: async () => null },
    });
    assert.deepEqual(
      await actionMissing.open({
        kind: 'action_successor',
        leaseId: 'lease-missing',
        generation: 1,
        holderCatId: 'codex-sol',
      }),
      { state: 'unknown_legacy', evidenceRefs: ['unknown:action_lease_missing'] },
    );

    const structuredMismatch = harness({
      projection: { state: 'active', holder: 'codex-terra' },
    });
    assert.deepEqual(
      await structuredMismatch.service.open({
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
      }),
      { state: 'unknown_legacy', evidenceRefs: ['unknown:structured_holder_mismatch'] },
    );

    const dispatchMissing = harness({
      projection: { state: 'active', holder: 'codex-sol' },
      events: [],
    });
    assert.deepEqual(
      await dispatchMissing.service.open({
        kind: 'structured',
        protocol: 'dispatch',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        handoff: {
          sourceEventId: 'route:message-missing:codex-sol',
          messageId: 'message-missing',
          fromCatId: 'opus',
        },
      }),
      { state: 'unknown_legacy', evidenceRefs: ['unknown:dispatch_handoff_missing'] },
    );
  });

  test('dispatch requires the exact current handoff even when an old projection has the same holder', async () => {
    const wake = {
      kind: 'structured',
      protocol: 'dispatch',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      handoff: {
        sourceEventId: 'route:current-message:codex-sol',
        messageId: 'current-message',
        fromCatId: 'opus',
      },
    };
    const stale = harness({
      projection: { state: 'active', holder: 'codex-sol' },
      events: [
        {
          kind: 'ball.handed',
          sourceEventId: 'route:old-message:codex-sol',
          payload: { fromCatId: 'opus', toCatId: 'codex-sol' },
        },
      ],
    });
    const staleOpened = await stale.service.open(wake);
    assert.equal(staleOpened.state, 'unknown_legacy');
    assert.equal((await stale.service.close(staleOpened)).shouldBlock, true);

    const exact = harness({
      projection: { state: 'active', holder: 'codex-sol' },
      events: [
        {
          kind: 'ball.handed',
          sourceEventId: 'route:current-message:codex-sol',
          payload: { fromCatId: 'opus', toCatId: 'codex-sol' },
        },
      ],
    });
    const exactOpened = await exact.service.open(wake);
    assert.equal(exactOpened.state, 'covered_active');
    assert.ok(exactOpened.evidenceRefs.includes('route:current-message:codex-sol'));
  });

  test('shadow comparison exposes old/new agreement and both disagreement directions', () => {
    assert.equal(compareTurnCustodyShadow(false, false), 'agree_allow');
    assert.equal(compareTurnCustodyShadow(true, true), 'agree_block');
    assert.equal(compareTurnCustodyShadow(true, false), 'old_only_block');
    assert.equal(compareTurnCustodyShadow(false, true), 'new_only_block');
  });
});
