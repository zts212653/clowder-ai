/**
 * F167 turn-scoped custody projection.
 *
 * Message lifecycle owns ordinary A2A, managed-hold, and event-wait wake
 * completion. The stop gate remains only for durable action successors and
 * genuinely unclassified legacy wakes.
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

function harness(currentLease = lease()) {
  let activeLease = currentLease;
  const service = new TurnCustodyProjectionService({
    actionSuccessorLeaseStore: {
      async get() {
        return activeLease;
      },
    },
  });
  return {
    service,
    setLease(next) {
      activeLease = next;
    },
  };
}

describe('F167 TurnCustodyProjectionService', () => {
  test('user chat, roam, cron, and protocol decline have zero stop obligation', async () => {
    const { service } = harness();
    for (const source of ['user_chat', 'roam', 'cron', 'protocol_decline']) {
      const opened = await service.open({ kind: 'unstructured', source });
      assert.deepEqual(opened, { state: 'covered_empty', evidenceRefs: [`wake:${source}`] });
      assert.deepEqual(await service.close(opened), {
        state: 'covered_empty',
        shouldBlock: false,
        transitionObserved: false,
        evidenceRefs: [`wake:${source}`],
      });
    }
  });

  test('machine-proven FYI and coordination clean-stops are non-obligating', async () => {
    const { service } = harness();
    for (const source of ['cross_thread_fyi', 'cross_thread_coordinate', 'coordination_terminal']) {
      const opened = await service.open({ kind: 'non_obligation', source });
      assert.deepEqual(opened, { state: 'covered_empty', evidenceRefs: [`wake:${source}`] });
      assert.equal((await service.close(opened)).shouldBlock, false);
    }
  });

  test('message lifecycle owns ordinary A2A, hold, and event-wait wake completion', async () => {
    const { service } = harness();
    const wakes = [
      {
        kind: 'structured',
        protocol: 'dispatch',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        handoff: { sourceEventId: 'handoff-1', messageId: 'message-1', fromCatId: 'opus' },
      },
      {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        sourceMessageId: 'message-2',
        taskId: 'hold-ball-2',
      },
      {
        kind: 'structured',
        protocol: 'event_wait',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        waitContinuationCarrier: {},
      },
    ];
    for (const wake of wakes) {
      const opened = await service.open(wake);
      assert.deepEqual(opened, { state: 'covered_empty', evidenceRefs: [`lifecycle:${wake.protocol}`] });
      assert.deepEqual(await service.close(opened), {
        state: 'covered_empty',
        shouldBlock: false,
        transitionObserved: false,
        evidenceRefs: [`lifecycle:${wake.protocol}`],
      });
    }
  });

  test('structured message wakes never consult legacy Ball holder/event truth', async () => {
    const service = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: { get: async () => Promise.reject(new Error('must not read')) },
      ballCustodyEventLog: { read: async () => Promise.reject(new Error('must not read')) },
    });
    const opened = await service.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      sourceMessageId: 'message-2',
      taskId: 'hold-ball-2',
    });
    assert.deepEqual(opened, { state: 'covered_empty', evidenceRefs: ['lifecycle:hold'] });
  });

  test('legacy text wake and action query failure stay fail-closed', async () => {
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
    assert.deepEqual(unavailable, { state: 'unknown_legacy', evidenceRefs: ['unknown:query_failed'] });
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

  test('candidate, holder outcome, transfer, and completion are action transitions', async () => {
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

  test('return transport retries alone do not satisfy an action transition', async () => {
    const h = harness();
    const opened = await h.service.open({
      kind: 'action_successor',
      leaseId: 'lease-1',
      generation: 3,
      holderCatId: 'codex-sol',
    });
    h.setLease(lease({ returnDeliveryAttemptCount: 2, returnDeliveryLastAttemptAt: 5, revision: 9, updatedAt: 5 }));
    assert.equal((await h.service.close(opened)).shouldBlock, true);
  });

  test('unknown action projections preserve bounded machine-readable reasons', async () => {
    const service = new TurnCustodyProjectionService({ actionSuccessorLeaseStore: { get: async () => null } });
    assert.deepEqual(
      await service.open({
        kind: 'action_successor',
        leaseId: 'lease-missing',
        generation: 1,
        holderCatId: 'codex-sol',
      }),
      { state: 'unknown_legacy', evidenceRefs: ['unknown:action_lease_missing'] },
    );
  });

  test('shadow comparison exposes old/new agreement and both disagreement directions', () => {
    assert.equal(compareTurnCustodyShadow(false, false), 'agree_allow');
    assert.equal(compareTurnCustodyShadow(true, true), 'agree_block');
    assert.equal(compareTurnCustodyShadow(true, false), 'old_only_block');
    assert.equal(compareTurnCustodyShadow(false, true), 'new_only_block');
  });
});
