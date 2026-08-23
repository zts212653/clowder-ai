import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { LocalReviewVerdictService } = await import('../dist/domains/ball-custody/LocalReviewVerdictService.js');
const { MessageStoreLocalReviewEvidenceProvider } = await import(
  '../dist/domains/ball-custody/LocalReviewEvidenceProvider.js'
);
const { claimActionSuccessor } = await import('../dist/domains/ball-custody/action-successor-state-machine.js');
const { recoverActiveLocalReviewVerdict } = await import(
  '../dist/domains/ball-custody/action-successor-local-review-recovery-state-machine.js'
);
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
    mentions: ['codex-sol'],
    extra: {
      targetCats: ['codex-sol'],
      crossPost: { sourceThreadId: 'thread-review', effectClass: 'coordinate' },
      stream: { invocationId: 'parent-inv-review-1', turnInvocationId: 'turn-inv-review-1' },
      localReviewVerdict: { verdict: 'changes_requested', clientMessageId: 'typed-verdict-1' },
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

  it('accepts the four incident prose shapes and ordinary human prose from one typed verdict carrier', async () => {
    const proseShapes = [
      `@codex-sol\n\nVERDICT: BLOCK (changes_requested) — exact HEAD ${HEAD}.`,
      `@codex-sol\n\nVERDICT: REQUEST_CHANGES — exact HEAD ${HEAD}.`,
      `@codex-sol\n\nverdict: changes_requested — exact HEAD ${HEAD}.`,
      '@codex-sol\n\n我看完了：这里还有一处授权边界需要修，改好再叫我。',
    ];

    for (const [index, content] of proseShapes.entries()) {
      const message = verdictMessage({
        id: `message-verdict-${index + 1}`,
        content,
        extra: {
          targetCats: ['codex-sol'],
          crossPost: { sourceThreadId: 'thread-review', effectClass: 'coordinate' },
          stream: { invocationId: 'parent-inv-review-1', turnInvocationId: 'turn-inv-review-1' },
          localReviewVerdict: {
            verdict: 'changes_requested',
            clientMessageId: `typed-verdict-${index + 1}`,
          },
        },
      });
      const { service, completeActionLease } = harness({ message });

      assert.deepEqual(
        await service.record(input({ messageId: message.id })),
        {
          outcome: 'committed',
          leaseId: 'lease-review-1',
          generation: 1,
          evidenceRef: `local-review:${message.id}:g1:changes_requested`,
        },
        `typed verdict must not depend on public prose shape ${index + 1}`,
      );
      assert.equal(completeActionLease.mock.calls.length, 1);
    }
  });

  it('fails closed for another holder or generation while deriving exact HEAD from the lease', async () => {
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
    assert.equal(completeActionLease.mock.calls.length, 0);
  });

  it('rejects a message outside the predecessor route but ignores verdict, subject, and HEAD prose', async () => {
    const wrongThread = harness({ message: verdictMessage({ threadId: 'thread-review' }) });
    assert.equal((await wrongThread.service.record(input())).outcome, 'mismatch');

    for (const content of [
      `@codex-sol\n\nAPPROVE — wrong prose verdict and no subject.`,
      `@codex-sol\n\nREQUEST_CHANGES — cat-cafe #9999 exact ${'b'.repeat(40)}.`,
    ]) {
      const proseIndependent = harness({ message: verdictMessage({ content }) });
      assert.equal((await proseIndependent.service.record(input())).outcome, 'committed');
      assert.equal(proseIndependent.completeActionLease.mock.calls.length, 1);
    }
  });

  it('derives the evidence verdict from typed message metadata and rejects its absence', async () => {
    const approved = harness({
      message: verdictMessage({
        content: '@codex-sol\n\n这版可以合。',
        extra: {
          targetCats: ['codex-sol'],
          crossPost: { sourceThreadId: 'thread-review', effectClass: 'coordinate' },
          stream: { invocationId: 'parent-inv-review-1', turnInvocationId: 'turn-inv-review-1' },
          localReviewVerdict: { verdict: 'approved', clientMessageId: 'typed-approved' },
        },
      }),
    });
    assert.deepEqual(await approved.service.record(input()), {
      outcome: 'committed',
      leaseId: 'lease-review-1',
      generation: 1,
      evidenceRef: 'local-review:message-verdict-1:g1:approved',
    });

    const missing = harness({
      message: verdictMessage({
        extra: {
          targetCats: ['codex-sol'],
          crossPost: { sourceThreadId: 'thread-review', effectClass: 'coordinate' },
          stream: { invocationId: 'parent-inv-review-1', turnInvocationId: 'turn-inv-review-1' },
        },
      }),
    });
    assert.deepEqual(await missing.service.record(input()), {
      outcome: 'insufficient',
      reason: 'local review message has no typed verdict fact',
    });
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
          localReviewVerdict: { verdict: 'changes_requested', clientMessageId: 'typed-verdict-1' },
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

function recoveryHarness({
  lease = createLease(),
  message = verdictMessage(),
  freshness = { status: 'mismatch', reason: 'predicate HEAD is not the tracking-observed current HEAD' },
  carrierRecordOverrides = { actionLeaseCarrier: { kind: 'none' } },
} = {}) {
  let current = lease;
  const recoveryCalls = [];
  const leaseStore = {
    async get(leaseId) {
      return current?.leaseId === leaseId ? current : null;
    },
    async recoverLocalReviewVerdict(leaseId, recovery) {
      recoveryCalls.push({ leaseId, recovery });
      await Promise.resolve();
      if (!current || current.leaseId !== leaseId) throw new Error('lease missing');
      const result = recoverActiveLocalReviewVerdict(current, recovery);
      if (result.outcome === 'recovered') current = result.lease;
      return result;
    },
  };
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
        actionLeaseCarrier: { kind: 'none' },
        ...carrierRecordOverrides,
      };
    },
  };
  return {
    recoveryCalls,
    getCurrentLease: () => current,
    service: new LocalReviewVerdictService({
      leaseStore,
      evidenceProvider: new MessageStoreLocalReviewEvidenceProvider(messageStore, invocationRecordStore),
      truthResolver: {
        async resolveFreshness() {
          return freshness;
        },
      },
      completeActionLease: async () => {
        throw new Error('ordinary completion must not run during historical recovery');
      },
    }),
  };
}

function recoveryInput(overrides = {}) {
  return {
    leaseId: 'lease-review-1',
    generation: 1,
    messageId: 'message-verdict-1',
    now: 300,
    principal: { catId: 'codex-sol', threadId: 'thread-author', tenantScope: 'user-1' },
    ...overrides,
  };
}

describe('F167 active stale local-review settlement recovery', () => {
  it('recovers the exact persisted F286 historical BLOCK verdict rendering', async () => {
    const subjectRef = 'pr:zts212653/cat-cafe#3424';
    const lease = createLease({
      subjectRef,
      terminalPredicate: canonicalizeActionTerminalPredicate({
        actionFamily: 'review',
        subjectRef,
        predicate: { kind: 'review_delivered', headSha: HEAD },
      }),
    });
    const message = verdictMessage({
      content:
        `@codex-sol\n\n**Verdict: BLOCK — 1 P1 remains** for PR #3424 exact HEAD \`${HEAD}\`.\n\n` +
        'Required repair: preserve the bounded recovery authorization contract.',
    });
    const { service } = recoveryHarness({ lease, message });

    assert.deepEqual(await service.recover(recoveryInput()), {
      outcome: 'committed',
      leaseId: 'lease-review-1',
      generation: 1,
      evidenceRef: 'local-review:message-verdict-1:g1:changes_requested',
    });
  });

  it('keeps historical recovery independent of legacy prose grammar', async () => {
    const subjectRef = 'pr:zts212653/cat-cafe#3424';
    const lease = createLease({
      subjectRef,
      terminalPredicate: canonicalizeActionTerminalPredicate({
        actionFamily: 'review',
        subjectRef,
        predicate: { kind: 'review_delivered', headSha: HEAD },
      }),
    });
    for (const content of [
      '@codex-sol\n\nNo machine tokens here; the typed fact is durable.',
      `@codex-sol\n\n**Verdict: BLOCKED** for PR #34240 exact HEAD \`${'b'.repeat(40)}\`.`,
    ]) {
      const proseIndependent = recoveryHarness({
        lease,
        message: verdictMessage({ content }),
      });
      assert.deepEqual(await proseIndependent.service.recover(recoveryInput()), {
        outcome: 'committed',
        leaseId: 'lease-review-1',
        generation: 1,
        evidenceRef: 'local-review:message-verdict-1:g1:changes_requested',
      });
    }
  });

  it('settles one exact active generation from the holder persisted verdict after server-observed HEAD advance', async () => {
    const { service, recoveryCalls, getCurrentLease } = recoveryHarness();

    assert.deepEqual(await service.recover(recoveryInput()), {
      outcome: 'committed',
      leaseId: 'lease-review-1',
      generation: 1,
      evidenceRef: 'local-review:message-verdict-1:g1:changes_requested',
    });
    assert.deepEqual(recoveryCalls[0], {
      leaseId: 'lease-review-1',
      recovery: {
        expectedGeneration: 1,
        reviewerCatId: 'codex-terra',
        predecessorCatId: 'codex-sol',
        predecessorThreadId: 'thread-author',
        tenantScope: 'user-1',
        headSha: HEAD,
        evidenceRef: 'local-review:message-verdict-1:g1:changes_requested',
        now: 300,
      },
    });
    assert.equal(getCurrentLease().status, 'completed');
    assert.equal(getCurrentLease().holderOutcomes['codex-terra'].outcome, 'succeeded');
  });

  it('authorizes the persisted predecessor identity from a later same-cat invocation and a server-verified stale HEAD', async () => {
    const wrongActor = recoveryHarness();
    assert.deepEqual(
      await wrongActor.service.recover(
        recoveryInput({ principal: { catId: 'opus', threadId: 'thread-author', tenantScope: 'user-1' } }),
      ),
      { outcome: 'mismatch', reason: 'local review recovery caller is not the lease predecessor' },
    );

    const laterInvocation = recoveryHarness();
    assert.equal(
      (
        await laterInvocation.service.recover(
          recoveryInput({ principal: { catId: 'codex-sol', threadId: 'thread-convergence', tenantScope: 'user-1' } }),
        )
      ).outcome,
      'committed',
    );

    const wrongTenant = recoveryHarness();
    assert.deepEqual(
      await wrongTenant.service.recover(
        recoveryInput({ principal: { catId: 'codex-sol', threadId: 'thread-convergence', tenantScope: 'user-2' } }),
      ),
      { outcome: 'mismatch', reason: 'local review recovery caller is outside the predecessor tenant' },
    );

    const stillCurrent = recoveryHarness({
      freshness: { status: 'verified', evidenceRef: 'tracking:current', freshnessKey: 'review-current' },
    });
    assert.deepEqual(await stillCurrent.service.recover(recoveryInput()), {
      outcome: 'mismatch',
      reason: 'local review lease HEAD is still current',
    });

    const unknownCurrentHead = recoveryHarness({
      freshness: { status: 'insufficient', reason: 'current HEAD projection unavailable' },
    });
    assert.deepEqual(await unknownCurrentHead.service.recover(recoveryInput()), {
      outcome: 'insufficient',
      reason: 'current HEAD projection unavailable',
    });
  });

  it('fails closed outside the exact untouched active single-review generation', async () => {
    const cases = [
      {
        lease: {
          ...createLease(),
          mode: 'parallel',
          holderCatIds: ['codex-terra', 'opus'],
          parallelIntent: 'independent review',
        },
        reason: 'local review recovery requires one review holder',
      },
      {
        lease: { ...createLease(), claimOrigin: 'existing_standing' },
        reason: 'local review recovery requires structured predecessor custody',
      },
      {
        lease: {
          ...createLease(),
          completionCandidates: {
            'codex-terra': {
              evidenceRefs: ['local-review:other:g1:approved'],
              candidateRevision: 1,
              evidenceDigest: 'x',
              recordedAt: 10,
            },
          },
        },
        reason: 'local review recovery requires an untouched active generation',
      },
      {
        lease: {
          ...createLease(),
          holderOutcomes: { 'codex-terra': { outcome: 'failed', evidenceRef: 'failure:old', at: 10 } },
        },
        reason: 'local review recovery requires an untouched active generation',
      },
      {
        lease: {
          ...createLease(),
          returnTransitions: [
            {
              fromGeneration: 1,
              toGeneration: 2,
              rejectingCatId: 'codex-terra',
              rejectingThreadId: 'thread-review',
              predecessorCatId: 'codex-sol',
              predecessorThreadId: 'thread-author',
              dispatchId: 'dispatch-returned',
              groundingEvidenceRef: 'message:return',
              returnedAt: 20,
            },
          ],
        },
        reason: 'local review recovery does not accept returned generations',
      },
    ];

    for (const testCase of cases) {
      const { service, recoveryCalls } = recoveryHarness({ lease: testCase.lease });
      assert.equal((await service.recover(recoveryInput())).reason, testCase.reason);
      assert.equal(recoveryCalls.length, 0);
    }
  });

  it('accepts an explicitly empty verdict-message carrier but rejects a conflicting action fence', async () => {
    const carrierless = recoveryHarness();
    assert.equal((await carrierless.service.recover(recoveryInput())).outcome, 'committed');

    const conflicting = recoveryHarness({
      carrierRecordOverrides: {
        actionLeaseCarrier: { kind: 'action_successor', leaseId: 'other-lease', generation: 1 },
      },
    });
    assert.deepEqual(await conflicting.service.recover(recoveryInput()), {
      outcome: 'mismatch',
      reason: 'local review verdict message carries a conflicting action lease generation',
    });
  });

  it('allows exactly one state transition and reports every identical concurrent replay as committed', async () => {
    const { service, recoveryCalls } = recoveryHarness();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => service.recover(recoveryInput())));

    assert.equal(outcomes.filter((result) => result.outcome === 'committed').length, 12);
    assert.equal(outcomes.filter((result) => result.outcome === 'stale').length, 0);
    assert.equal(recoveryCalls.length, 12);
  });
});
