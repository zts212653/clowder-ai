import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { LocalReviewVerdictService } = await import('../dist/domains/ball-custody/LocalReviewVerdictService.js');
const { MessageStoreLocalReviewEvidenceProvider } = await import(
  '../dist/domains/ball-custody/LocalReviewEvidenceProvider.js'
);
const { claimActionSuccessor } = await import('../dist/domains/ball-custody/action-successor-state-machine.js');
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);

const HEAD = 'a'.repeat(40);

function createLease(overrides = {}) {
  return claimActionSuccessor(null, {
    leaseId: 'lease-review-1',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#3333',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex-terra'],
    dispatchId: 'dispatch-review-1',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-review',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'message:request-1',
    evidenceRefs: ['message:request-1'],
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#3333',
      predicate: { kind: 'review_delivered', headSha: HEAD },
    }),
    now: 100,
    ...overrides,
  }).lease;
}

function verdictMessage(overrides = {}) {
  return {
    id: 'message-verdict-1',
    threadId: 'thread-author',
    userId: 'user-1',
    catId: 'codex-terra',
    content: `@codex-sol\n\nREQUEST_CHANGES — repo #3333 exact ${HEAD}.`,
    extra: {
      targetCats: ['codex-sol'],
      crossPost: { sourceThreadId: 'thread-review', effectClass: 'coordinate' },
      stream: { invocationId: 'parent-inv-review-1', turnInvocationId: 'turn-inv-review-1' },
    },
    ...overrides,
  };
}

function harness({
  lease = createLease(),
  message = verdictMessage(),
  carrierLeaseId = lease.leaseId,
  carrierGeneration = lease.generation,
  carrierRecordOverrides = {},
  completionOutcome,
} = {}) {
  const completeActionLease = mock.fn(
    async () =>
      completionOutcome ?? {
        outcome: 'committed',
        leaseId: lease.leaseId,
        generation: lease.generation,
      },
  );
  const messageStore = {
    async getById(messageId) {
      return message?.id === messageId ? message : null;
    },
  };
  const invocationRecordStore = {
    async get(invocationId) {
      if (invocationId !== 'parent-inv-review-1') return null;
      return {
        id: invocationId,
        threadId: 'thread-review',
        userId: 'user-1',
        targetCats: ['codex-terra'],
        actionLeaseCarrier: {
          kind: 'action_successor',
          leaseId: carrierLeaseId,
          generation: carrierGeneration,
        },
        ...carrierRecordOverrides,
      };
    },
  };
  return {
    completeActionLease,
    service: new LocalReviewVerdictService({
      leaseStore: {
        async get(leaseId) {
          return lease.leaseId === leaseId ? lease : null;
        },
      },
      evidenceProvider: new MessageStoreLocalReviewEvidenceProvider(messageStore, invocationRecordStore),
      completeActionLease,
    }),
  };
}

function input(overrides = {}) {
  return {
    leaseId: 'lease-review-1',
    generation: 1,
    messageId: 'message-verdict-1',
    headSha: HEAD,
    verdict: 'changes_requested',
    now: 200,
    principal: { catId: 'codex-terra', threadId: 'thread-review', tenantScope: 'user-1' },
    ...overrides,
  };
}

describe('F167 local review verdict completion producer', () => {
  it('commits only a persisted verdict returned through the exact predecessor route', async () => {
    const { service, completeActionLease } = harness();

    assert.deepEqual(await service.record(input()), {
      outcome: 'committed',
      leaseId: 'lease-review-1',
      generation: 1,
      evidenceRef: 'local-review:message-verdict-1:g1:changes_requested',
    });
    assert.deepEqual(completeActionLease.mock.calls[0].arguments[0], {
      leaseId: 'lease-review-1',
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['local-review:message-verdict-1:g1:changes_requested'],
      now: 200,
    });
  });

  it('fails closed for another holder, generation, or exact HEAD', async () => {
    const { service, completeActionLease } = harness();

    assert.equal(
      (await service.record(input({ principal: { catId: 'opus', threadId: 'thread-review', tenantScope: 'user-1' } })))
        .outcome,
      'mismatch',
    );
    assert.equal(
      (
        await service.record(
          input({ principal: { catId: 'codex-terra', threadId: 'other-thread', tenantScope: 'user-1' } }),
        )
      ).outcome,
      'mismatch',
    );
    assert.equal((await service.record(input({ generation: 2 }))).outcome, 'stale');
    assert.equal((await service.record(input({ headSha: 'b'.repeat(40) }))).outcome, 'mismatch');
    assert.equal(completeActionLease.mock.calls.length, 0);
  });

  it('rejects a message outside the predecessor route or without the declared verdict', async () => {
    const wrongThread = harness({ message: verdictMessage({ threadId: 'thread-review' }) });
    assert.equal((await wrongThread.service.record(input())).outcome, 'mismatch');

    const wrongVerdict = harness({
      message: verdictMessage({ content: `@codex-sol\n\nAPPROVE — repo #3333 exact ${HEAD}.` }),
    });
    assert.equal((await wrongVerdict.service.record(input())).outcome, 'mismatch');

    const wrongSubject = harness({
      message: verdictMessage({ content: `@codex-sol\n\nREQUEST_CHANGES — cat-cafe #9999 exact ${HEAD}.` }),
    });
    assert.equal((await wrongSubject.service.record(input())).outcome, 'mismatch');
  });

  it('rejects subject anchors whose PR number or repository token merely extends the lease subject', async () => {
    for (const content of [
      `@codex-sol\n\nREQUEST_CHANGES — repo #33330 exact ${HEAD}.`,
      `@codex-sol\n\nREQUEST_CHANGES — pr:owner/repo#33330 exact ${HEAD}.`,
      `@codex-sol\n\nREQUEST_CHANGES — owner/repository#3333 exact ${HEAD}.`,
      `@codex-sol\n\nREQUEST_CHANGES — github.com/owner/repo/pull/33330 exact ${HEAD}.`,
    ]) {
      const { service, completeActionLease } = harness({ message: verdictMessage({ content }) });

      assert.deepEqual(await service.record(input()), {
        outcome: 'mismatch',
        reason: 'local review verdict does not bind the action subject',
      });
      assert.equal(completeActionLease.mock.calls.length, 0);
    }
  });

  it('rejects a verdict message linked to an older action-lease generation', async () => {
    const lease = { ...createLease(), generation: 2 };
    const { service, completeActionLease } = harness({ lease, carrierGeneration: 1 });

    assert.deepEqual(await service.record(input({ generation: 2 })), {
      outcome: 'mismatch',
      reason: 'local review verdict message does not carry the current action lease generation',
    });
    assert.equal(completeActionLease.mock.calls.length, 0);
  });

  it('fails closed when verdict-message carrier provenance is missing or outside the lease scope', async () => {
    const withoutCarrierLink = harness({
      message: verdictMessage({
        extra: {
          targetCats: ['codex-sol'],
          crossPost: { sourceThreadId: 'thread-review', effectClass: 'coordinate' },
        },
      }),
    });
    assert.deepEqual(await withoutCarrierLink.service.record(input()), {
      outcome: 'insufficient',
      reason: 'local review verdict message has no invocation carrier provenance',
    });

    const wrongLease = harness({ carrierLeaseId: 'lease-review-other' });
    assert.deepEqual(await wrongLease.service.record(input()), {
      outcome: 'mismatch',
      reason: 'local review verdict message does not carry the current action lease generation',
    });

    const wrongPrincipal = harness({ carrierRecordOverrides: { targetCats: ['opus'] } });
    assert.deepEqual(await wrongPrincipal.service.record(input()), {
      outcome: 'mismatch',
      reason: 'local review verdict invocation carrier is outside the message principal scope',
    });
  });

  it('rejects existing-standing review custody without a structured author return route', async () => {
    const lease = createLease({
      claimOrigin: 'existing_standing',
      predecessorCatId: undefined,
      predecessorThreadId: undefined,
    });
    const { service, completeActionLease } = harness({ lease });

    assert.deepEqual(await service.record(input()), {
      outcome: 'insufficient',
      reason: 'local review lease has no structured predecessor route',
    });
    assert.equal(completeActionLease.mock.calls.length, 0);
  });
});
