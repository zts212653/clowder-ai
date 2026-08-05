import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { ActionSuccessorAdmissionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);

const request = (overrides = {}) => ({
  tenantScope: 'user-1',
  actorCatId: 'codex-sol',
  sourceThreadId: 'thread-source',
  targetThreadId: 'thread-target',
  holderCatIds: ['codex-terra'],
  dispatchId: 'multi-mention:req-1',
  evidenceRef: 'message:req-1',
  now: 100,
  action: {
    subjectRef: 'pr:owner/repo#2868',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: { kind: 'review_delivered', headSha: '1111111111111111111111111111111111111111' },
  },
  ...overrides,
});

function harness({
  resolution,
  freshnessResolution,
  claimResult,
  currentLease = null,
  replaceResult,
  returnResult,
  deliveredResult,
  continueResult,
} = {}) {
  const calls = {
    claim: [],
    get: [],
    replace: [],
    resolveFreshness: [],
    returnToPredecessor: [],
    markReturnDelivered: [],
    recordOutcome: [],
    commitOutcome: [],
    continueFreshRevision: [],
  };
  const truthResolver = {
    async resolve(...args) {
      return (
        (typeof resolution === 'function' ? await resolution(...args) : resolution) ?? {
          terminal: false,
          source: 'community_projection',
          state: 'active',
        }
      );
    },
    async resolveFreshness(predicate) {
      calls.resolveFreshness.push(predicate);
      const configured =
        typeof freshnessResolution === 'function' ? await freshnessResolution(predicate) : freshnessResolution;
      return (
        configured ?? {
          status: 'verified',
          evidenceRef: `community:${predicate.subjectRef}:head:${predicate.headSha}`,
          freshnessKey: predicate.freshnessKey,
        }
      );
    },
  };
  const leaseStore = {
    async claim(input) {
      calls.claim.push(input);
      return claimResult;
    },
    async get(id) {
      calls.get.push(id);
      return currentLease;
    },
    async replace(id, input) {
      calls.replace.push({ id, input });
      return replaceResult;
    },
    async returnToPredecessor(id, input) {
      calls.returnToPredecessor.push({ id, input });
      return returnResult;
    },
    async markReturnDelivered(id, input) {
      calls.markReturnDelivered.push({ id, input });
      return deliveredResult ?? { outcome: 'delivered' };
    },
    async recordOutcome(id, input) {
      calls.recordOutcome.push({ id, input });
      return currentLease;
    },
    async commitOutcome(id, input) {
      calls.commitOutcome.push({ id, input });
      return { outcome: 'recorded', lease: currentLease };
    },
    async continueFreshRevision(id, input) {
      calls.continueFreshRevision.push({ id, input });
      return continueResult;
    },
  };
  return { service: new ActionSuccessorAdmissionService(leaseStore, truthResolver), calls };
}

describe('ActionSuccessorAdmissionService', () => {
  it('admits a task standing only for the persisted owner, tenant, and task thread', async () => {
    const activeLease = {
      leaseId: 'lease-task-1',
      generation: 1,
      status: 'active',
      holderCatIds: ['opus'],
      terminalPredicate: canonicalizeActionTerminalPredicate({
        actionFamily: 'implement',
        subjectRef: 'subject:task:task-1',
        predicate: { kind: 'task_done' },
      }),
    };
    const freshnessResolution = {
      status: 'verified',
      evidenceRef: 'task:task-1:active:210',
      freshnessKey: 'task:task-1',
      ownerCatId: 'opus',
      holderThreadId: 'thread-task',
      tenantScope: 'user-1',
    };
    const { service, calls } = harness({
      freshnessResolution,
      claimResult: { outcome: 'claimed', lease: activeLease },
    });
    const action = {
      subjectRef: 'subject:task:task-1',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'message:task-assignment',
      terminalPredicate: { kind: 'task_done' },
    };

    const admitted = await service.admit(
      request({
        tenantScope: 'user-1',
        actorCatId: 'opus',
        sourceThreadId: 'thread-task',
        targetThreadId: 'thread-task',
        holderCatIds: ['opus'],
        action,
      }),
    );
    assert.equal(admitted.admit, true);
    assert.equal(calls.claim.length, 1);

    for (const overrides of [
      { actorCatId: 'codex-sol', holderCatIds: ['codex-sol'] },
      { targetThreadId: 'thread-wrong' },
      { tenantScope: 'user-wrong' },
    ]) {
      await assert.rejects(
        service.admit(
          request({
            tenantScope: 'user-1',
            actorCatId: 'opus',
            sourceThreadId: 'thread-task',
            targetThreadId: 'thread-task',
            holderCatIds: ['opus'],
            action,
            ...overrides,
          }),
        ),
        /task standing does not match/,
      );
    }
  });

  it('rejects an old reviewer re-entry after a consumed review when no provenance route is supplied', async () => {
    const oldPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const completedLease = {
      leaseId: 'lease-1',
      generation: 1,
      status: 'completed',
      actionFamily: 'review',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      terminalPredicate: oldPredicate,
    };
    const { service, calls } = harness({
      claimResult: { outcome: 'safe_wait', lease: completedLease },
    });

    const result = await service.admit(
      request({
        dispatchId: 'multi-mention:unproven-review-reentry',
        action: {
          ...request().action,
          terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      }),
    );

    assert.equal(result.admit, false);
    assert.equal(result.outcome, 'review_reentry_ineligible');
    assert.equal(calls.resolveFreshness.length, 1, 'initial current-HEAD verification still runs');
    assert.equal(calls.continueFreshRevision.length, 0, 'an unproven old-reviewer route must not create a generation');

    for (const evidenceRef of ['caller-says-there-is-a-delta', 'message:', 'git:']) {
      const ungrounded = await service.admit(
        request({
          dispatchId: `multi-mention:ungrounded-review-reentry:${evidenceRef}`,
          action: {
            ...request().action,
            reviewReentry: { reason: 'behavioral_delta', evidenceRef },
            terminalPredicate: {
              kind: 'review_delivered',
              headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          },
        }),
      );
      assert.equal(ungrounded.admit, false);
      assert.equal(ungrounded.outcome, 'review_reentry_ineligible');
    }
    assert.equal(calls.continueFreshRevision.length, 0, 'free-form caller claims are not durable route evidence');
  });

  it('continues a completed review lease when a behavioral delta is grounded against a new HEAD', async () => {
    const oldPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const newPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const completedLease = {
      leaseId: 'lease-1',
      generation: 1,
      status: 'completed',
      actionFamily: 'review',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      terminalPredicate: oldPredicate,
    };
    const continuedLease = { ...completedLease, generation: 2, status: 'active', terminalPredicate: newPredicate };
    const { service, calls } = harness({
      claimResult: { outcome: 'safe_wait', lease: completedLease },
      freshnessResolution: {
        status: 'verified',
        evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        freshnessKey: newPredicate.freshnessKey,
      },
      continueResult: { outcome: 'continued', lease: continuedLease },
    });

    const result = await service.admit(
      request({
        dispatchId: 'multi-mention:req-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'review',
          successorSlot: 'reviewer',
          mode: 'single',
          reviewReentry: {
            reason: 'behavioral_delta',
            evidenceRef: 'git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:authored-delta',
          },
          terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      }),
    );

    assert.equal(result.admit, true);
    assert.equal(result.outcome, 'continued');
    assert.equal(result.fence.generation, 2);
    assert.equal(result.fence.terminalPredicateDigest, newPredicate.digest);
    assert.equal(calls.continueFreshRevision.length, 1);
    assert.equal(calls.continueFreshRevision[0].input.expectedGeneration, 1);
    assert.equal(calls.continueFreshRevision[0].input.claimOrigin, 'structured_transfer');
    assert.equal(calls.continueFreshRevision[0].input.reviewReentry.reason, 'behavioral_delta');
    assert.equal(
      calls.continueFreshRevision[0].input.reviewReentry.evidenceRef,
      'git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:authored-delta',
    );
  });

  it('keeps stale/blocking and explicit matrix routes eligible for a verified fresh revision', async () => {
    for (const reason of ['stale_or_blocking', 'explicit_matrix_route']) {
      const oldPredicate = canonicalizeActionTerminalPredicate({
        actionFamily: 'review',
        subjectRef: 'pr:owner/repo#2868',
        predicate: { kind: 'review_delivered', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      const newPredicate = canonicalizeActionTerminalPredicate({
        actionFamily: 'review',
        subjectRef: 'pr:owner/repo#2868',
        predicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      });
      const completedLease = {
        leaseId: `lease-${reason}`,
        generation: 1,
        status: 'completed',
        actionFamily: 'review',
        mode: 'single',
        holderCatIds: ['codex-terra'],
        terminalPredicate: oldPredicate,
      };
      const continuedLease = { ...completedLease, generation: 2, status: 'active', terminalPredicate: newPredicate };
      const { service, calls } = harness({
        claimResult: { outcome: 'safe_wait', lease: completedLease },
        continueResult: { outcome: 'continued', lease: continuedLease },
      });

      const result = await service.admit(
        request({
          dispatchId: `multi-mention:${reason}`,
          action: {
            ...request().action,
            reviewReentry: { reason, evidenceRef: `message:${reason}:route-proof` },
            terminalPredicate: {
              kind: 'review_delivered',
              headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          },
        }),
      );

      assert.equal(result.admit, true, reason);
      assert.equal(result.outcome, 'continued', reason);
      assert.equal(calls.continueFreshRevision[0].input.reviewReentry.reason, reason);
    }
  });

  it('continues a completed legacy lease when server truth verifies the current HEAD', async () => {
    const newPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const completedLease = {
      leaseId: 'lease-legacy',
      generation: 1,
      status: 'completed',
      actionFamily: 'review',
      mode: 'single',
      holderCatIds: ['codex-terra'],
    };
    const continuedLease = {
      ...completedLease,
      generation: 2,
      status: 'active',
      terminalPredicate: newPredicate,
    };
    const { service, calls } = harness({
      claimResult: { outcome: 'safe_wait', lease: completedLease },
      freshnessResolution: {
        status: 'verified',
        evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        freshnessKey: newPredicate.freshnessKey,
      },
      continueResult: { outcome: 'continued', lease: continuedLease },
    });

    const result = await service.admit(
      request({
        dispatchId: 'multi-mention:legacy-to-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'review',
          successorSlot: 'reviewer',
          mode: 'single',
          reviewReentry: {
            reason: 'stale_or_blocking',
            evidenceRef: 'message:legacy-review-route',
          },
          terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      }),
    );

    assert.equal(result.admit, true);
    assert.equal(result.outcome, 'continued');
    assert.equal(result.fence.generation, 2);
    assert.equal(calls.continueFreshRevision.length, 1);
  });

  it('surfaces terminal truth when the fresh-revision CAS loses to a terminal marker', async () => {
    const oldPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const newPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const completedLease = {
      leaseId: 'lease-1',
      generation: 1,
      status: 'completed',
      actionFamily: 'review',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      terminalPredicate: oldPredicate,
    };
    const terminal = {
      subjectRef: 'pr:owner/repo#2868',
      state: 'merged',
      evidenceRef: 'github:merged-during-cas',
      observedAt: 101,
    };
    let resolveCalls = 0;
    const { service, calls } = harness({
      resolution: async () => {
        resolveCalls += 1;
        return resolveCalls === 1
          ? { terminal: false, source: 'community_projection', state: 'active' }
          : { terminal: true, source: 'marker', truth: terminal };
      },
      claimResult: { outcome: 'safe_wait', lease: completedLease },
      freshnessResolution: {
        status: 'verified',
        evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        freshnessKey: newPredicate.freshnessKey,
      },
      continueResult: { outcome: 'subject_terminal', lease: completedLease },
    });

    const result = await service.admit(
      request({
        dispatchId: 'multi-mention:req-cas-race',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'review',
          successorSlot: 'reviewer',
          mode: 'single',
          reviewReentry: {
            reason: 'explicit_matrix_route',
            evidenceRef: 'message:terminal-cas-review-route',
          },
          terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      }),
    );

    assert.deepEqual(result, { admit: false, outcome: 'subject_terminal', terminal });
    assert.equal(resolveCalls, 2);
    assert.equal(calls.continueFreshRevision.length, 1);
  });

  it('fails closed when terminal-aware CAS and the durable truth resolver disagree', async () => {
    const oldPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const newPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const completedLease = {
      leaseId: 'lease-1',
      generation: 1,
      status: 'completed',
      actionFamily: 'review',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      terminalPredicate: oldPredicate,
    };
    let resolveCalls = 0;
    const { service } = harness({
      resolution: async () => {
        resolveCalls += 1;
        return { terminal: false, source: 'community_projection', state: 'active' };
      },
      claimResult: { outcome: 'safe_wait', lease: completedLease },
      freshnessResolution: {
        status: 'verified',
        evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        freshnessKey: newPredicate.freshnessKey,
      },
      continueResult: { outcome: 'subject_terminal', lease: completedLease },
    });

    await assert.rejects(
      () =>
        service.admit(
          request({
            action: {
              ...request().action,
              reviewReentry: {
                reason: 'explicit_matrix_route',
                evidenceRef: 'message:disputed-terminal-cas-review-route',
              },
              terminalPredicate: {
                kind: 'review_delivered',
                headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            },
          }),
        ),
      /fresh-revision CAS reported subject_terminal without durable terminal truth/,
    );
    assert.equal(resolveCalls, 2);
  });

  it('admits a new single successor and returns a queue fence', async () => {
    const lease = { leaseId: 'lease-1', generation: 1, mode: 'single', holderCatIds: ['codex-terra'] };
    const { service, calls } = harness({ claimResult: { outcome: 'claimed', lease } });
    assert.deepEqual(
      await service.admit(
        request({ action: { ...request().action, groundingEvidenceRef: 'caller:spoofed-standing-evidence' } }),
      ),
      {
        admit: true,
        outcome: 'claimed',
        lease,
        fence: { leaseId: 'lease-1', generation: 1, dispatchId: 'multi-mention:req-1' },
      },
    );
    assert.deepEqual(calls.claim[0].holderCatIds, ['codex-terra']);
    assert.equal(calls.claim[0].holderThreadId, 'thread-target');
    assert.equal(calls.claim[0].predecessorCatId, 'codex-sol');
    assert.equal(calls.claim[0].predecessorThreadId, 'thread-source');
    assert.equal(calls.claim[0].claimOrigin, 'structured_transfer');
    assert.equal(calls.claim[0].issuerStandingEvidenceRef, 'message:req-1');
    assert.equal(calls.resolveFreshness.length, 1);
    assert.equal(calls.resolveFreshness[0].headSha, '1111111111111111111111111111111111111111');
  });

  it('rejects non-exact freshness before a new claim', async () => {
    for (const { freshnessResolution, expectedStatus } of [
      { freshnessResolution: { status: 'mismatch', reason: 'predicate HEAD is stale' }, expectedStatus: 'mismatch' },
      {
        freshnessResolution: { status: 'insufficient', reason: 'current HEAD unavailable' },
        expectedStatus: 'insufficient',
      },
      {
        freshnessResolution: {
          status: 'verified',
          evidenceRef: 'community:wrong-head',
          freshnessKey: 'review:wrong-head',
        },
        expectedStatus: 'mismatch',
      },
    ]) {
      const { service, calls } = harness({
        freshnessResolution,
        claimResult: {
          outcome: 'claimed',
          lease: { leaseId: 'must-not-exist', generation: 1, mode: 'single', holderCatIds: ['codex-terra'] },
        },
      });

      await assert.rejects(
        () => service.admit(request()),
        new RegExp(`action successor freshness rejected: ${expectedStatus}`),
      );
      assert.equal(calls.resolveFreshness.length, 1);
      assert.equal(calls.claim.length, 0);
    }
  });

  it('does not mint a reviewer lease from a terminal PR tracking task when community HEAD is unavailable', async () => {
    for (const prState of ['merged', 'closed']) {
      const terminalTask = {
        kind: 'pr_tracking',
        status: 'done',
        automationState: {
          ci: {
            headSha: '1111111111111111111111111111111111111111',
            prState,
          },
        },
      };
      const claimCalls = [];
      const leaseStore = {
        async getSubjectTerminal() {
          return null;
        },
        async markSubjectTerminal() {
          throw new Error('terminal marker write is not expected');
        },
        async clearSubjectTerminal() {
          throw new Error('terminal marker clear is not expected');
        },
        async claim(input) {
          claimCalls.push(input);
          return {
            outcome: 'claimed',
            lease: {
              leaseId: `lease-${prState}`,
              generation: 1,
              mode: 'single',
              holderCatIds: ['codex-terra'],
            },
          };
        },
        async get() {
          return null;
        },
        async replace() {
          throw new Error('replace is not expected');
        },
        async commitOutcome() {
          throw new Error('commitOutcome is not expected');
        },
        async returnToPredecessor() {
          throw new Error('returnToPredecessor is not expected');
        },
        async markReturnDelivered() {
          throw new Error('markReturnDelivered is not expected');
        },
        async continueFreshRevision() {
          throw new Error('continueFreshRevision is not expected');
        },
      };
      const resolver = new ActionSubjectTruthResolver(
        leaseStore,
        {
          async get() {
            return null;
          },
        },
        {
          async getBySubject() {
            return {
              kind: terminalTask.kind,
              status: terminalTask.status,
              headSha: terminalTask.automationState.ci.headSha,
              ciPrState: terminalTask.automationState.ci.prState,
              reviewPrState: null,
              closedAt: null,
            };
          },
        },
      );
      const service = new ActionSuccessorAdmissionService(leaseStore, resolver);

      await assert.rejects(
        () => service.admit(request({ dispatchId: `terminal-tracking:${prState}` })),
        /action successor freshness rejected: insufficient/,
      );
      assert.equal(claimCalls.length, 0, `${prState} tracker must not reach leaseStore.claim`);
    }
  });

  it('lets a grounded actor claim existing standing through the same CAS only for itself', async () => {
    const lease = { leaseId: 'lease-standing', generation: 1, mode: 'single', holderCatIds: ['codex-sol'] };
    const { service, calls } = harness({ claimResult: { outcome: 'claimed', lease } });
    const standingRequest = request({
      holderCatIds: ['codex-sol'],
      action: {
        ...request().action,
        claimOrigin: 'existing_standing',
        groundingEvidenceRef: 'grounding:verified-owner',
      },
    });

    assert.equal((await service.admit(standingRequest)).outcome, 'claimed');
    assert.equal(calls.claim[0].claimOrigin, 'existing_standing');
    assert.equal(calls.claim[0].issuerStandingEvidenceRef, 'grounding:verified-owner');
    assert.equal(calls.claim[0].predecessorCatId, undefined);
    assert.equal(calls.claim[0].predecessorThreadId, undefined);

    await assert.rejects(
      () => service.admit({ ...standingRequest, holderCatIds: ['codex-terra'] }),
      /must target the authenticated actor only/,
    );
    assert.equal(calls.claim.length, 1);
  });

  it('turns active conflicts, retries, and replay mismatches into no-dispatch results', async () => {
    const lease = { leaseId: 'lease-1', generation: 1 };
    const conflict = harness({ claimResult: { outcome: 'safe_wait', lease } });
    assert.deepEqual(await conflict.service.admit(request()), {
      admit: false,
      outcome: 'safe_wait',
      lease,
    });

    const replay = harness({ claimResult: { outcome: 'replayed', lease } });
    assert.deepEqual(await replay.service.admit(request()), {
      admit: false,
      outcome: 'replayed',
      lease,
    });

    const mismatch = harness({ claimResult: { outcome: 'replay_mismatch', lease } });
    assert.deepEqual(await mismatch.service.admit(request()), {
      admit: false,
      outcome: 'replay_mismatch',
      lease,
    });
  });

  it('checks terminal truth before creating a lease', async () => {
    const truth = {
      subjectRef: 'pr:owner/repo#2868',
      state: 'merged',
      evidenceRef: 'github:merged',
      observedAt: 90,
    };
    const { service, calls } = harness({ resolution: { terminal: true, source: 'marker', truth } });
    assert.deepEqual(await service.admit(request()), {
      admit: false,
      outcome: 'subject_terminal',
      terminal: truth,
    });
    assert.equal(calls.claim.length, 0);
  });

  it('uses replace only with the current matching lease and expected generation', async () => {
    const newPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      mode: 'single',
      holderCatIds: ['codex-terra'],
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
    };
    const replacedLease = { ...currentLease, generation: 2, dispatchId: 'multi-mention:req-2' };
    const { service, calls } = harness({
      currentLease,
      replaceResult: { outcome: 'replaced', lease: replacedLease },
    });
    const result = await service.admit(
      request({
        dispatchId: 'multi-mention:req-2',
        action: {
          ...request().action,
          terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          replace: { leaseId: 'lease-1', expectedGeneration: 1 },
        },
      }),
    );
    assert.equal(result.admit, true);
    assert.equal(result.outcome, 'replaced');
    assert.deepEqual(result.fence, {
      leaseId: 'lease-1',
      generation: 2,
      dispatchId: 'multi-mention:req-2',
    });
    assert.equal(calls.claim.length, 0);
    assert.equal(calls.replace.length, 1);
    assert.equal(calls.replace[0].input.terminalPredicate.digest, newPredicate.digest);
    assert.equal(calls.resolveFreshness.length, 1);
    assert.equal(calls.resolveFreshness[0].freshnessKey, newPredicate.freshnessKey);

    await assert.rejects(
      () =>
        service.admit(
          request({
            actorCatId: 'gpt52',
            action: {
              ...request().action,
              replace: { leaseId: 'lease-1', expectedGeneration: 1 },
            },
          }),
        ),
      /replacement must originate from the persisted issuer route/,
    );
    assert.equal(calls.replace.length, 1);
  });

  it('reattaches only the returned predecessor route with a fresh predicate and exact return proof', async () => {
    const oldPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      tenantScope: 'user-1',
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      generation: 2,
      revision: 3,
      status: 'active',
      mode: 'single',
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-source',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-terra',
      predecessorThreadId: 'thread-target',
      issuerStandingEvidenceRef: 'message:grounding-mismatch',
      terminalPredicate: oldPredicate,
      holderOutcomes: {},
      completionCandidates: {},
      evidenceRefs: ['message:request-1', 'message:grounding-mismatch'],
      returnDeliveryState: 'pending',
      returnDeliveryEvidenceRef: 'message:grounding-mismatch',
      returnTransitions: [
        {
          outcome: 'rejected_ownership',
          fromGeneration: 1,
          toGeneration: 2,
          rejectingCatId: 'codex-terra',
          rejectingThreadId: 'thread-target',
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-source',
          groundingEvidenceRef: 'message:grounding-mismatch',
          at: 90,
        },
      ],
    };
    const reattachedLease = { ...currentLease, generation: 3, holderCatIds: ['gpt52'] };
    const { service, calls } = harness({
      currentLease,
      replaceResult: { outcome: 'reattached', lease: reattachedLease },
    });

    const result = await service.admit(
      request({
        actorCatId: 'codex-sol',
        sourceThreadId: 'thread-source',
        targetThreadId: 'thread-next-review',
        holderCatIds: ['gpt52'],
        dispatchId: 'post:fresh-review',
        incomingActionLeaseRef: { leaseId: 'lease-1', generation: 2 },
        action: {
          ...request().action,
          terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          replace: { leaseId: 'lease-1', expectedGeneration: 2 },
        },
      }),
    );

    assert.equal(result.admit, true);
    assert.equal(result.outcome, 'reattached');
    assert.equal(calls.replace.length, 1);
    assert.equal(calls.replace[0].input.returnedHolderCatId, 'codex-sol');
    assert.equal(calls.replace[0].input.returnedHolderThreadId, 'thread-source');
    assert.deepEqual(calls.replace[0].input.returnProof, {
      kind: 'returned_fence',
      leaseId: 'lease-1',
      generation: 2,
    });
    assert.match(calls.replace[0].input.freshnessEvidenceRef, /^community:/);

    for (const overrides of [{ actorCatId: 'codex-terra' }, { sourceThreadId: 'thread-target' }]) {
      await assert.rejects(
        () =>
          service.admit(
            request({
              actorCatId: 'codex-sol',
              sourceThreadId: 'thread-source',
              targetThreadId: 'thread-next-review',
              holderCatIds: ['gpt52'],
              incomingActionLeaseRef: { leaseId: 'lease-1', generation: 2 },
              action: {
                ...request().action,
                terminalPredicate: {
                  kind: 'review_delivered',
                  headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                },
                replace: { leaseId: 'lease-1', expectedGeneration: 2 },
              },
              ...overrides,
            }),
          ),
        /returned holder route/,
      );
    }
    assert.equal(calls.replace.length, 1);
  });

  it('requires either the exact returned fence or persisted delivered-return evidence', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 2,
      status: 'active',
      mode: 'single',
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-source',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-terra',
      predecessorThreadId: 'thread-target',
      holderOutcomes: {},
      completionCandidates: {},
      returnDeliveryState: 'pending',
      returnTransitions: [
        {
          outcome: 'rejected_ownership',
          fromGeneration: 1,
          toGeneration: 2,
          rejectingCatId: 'codex-terra',
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-source',
          groundingEvidenceRef: 'message:mismatch',
          at: 90,
        },
      ],
    };
    const action = {
      ...request().action,
      terminalPredicate: { kind: 'review_delivered', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      replace: { leaseId: 'lease-1', expectedGeneration: 2 },
    };
    const missing = harness({ currentLease, replaceResult: { outcome: 'reattached', lease: currentLease } });
    const rejected = await missing.service.admit(
      request({
        sourceThreadId: 'thread-source',
        targetThreadId: 'thread-next-review',
        holderCatIds: ['gpt52'],
        action,
      }),
    );
    assert.equal(rejected.admit, false);
    assert.equal(rejected.outcome, 'return_proof_required');
    assert.equal(missing.calls.replace.length, 0);

    const deliveredLease = {
      ...currentLease,
      returnDeliveryState: 'delivered',
      returnDeliveryEvidenceRef: 'queue:return-1:return_enqueued',
    };
    const delivered = harness({
      currentLease: deliveredLease,
      replaceResult: { outcome: 'reattached', lease: { ...deliveredLease, generation: 3 } },
    });
    const accepted = await delivered.service.admit(
      request({
        sourceThreadId: 'thread-source',
        targetThreadId: 'thread-next-review',
        holderCatIds: ['gpt52'],
        action,
      }),
    );
    assert.equal(accepted.outcome, 'reattached');
    assert.deepEqual(delivered.calls.replace[0].input.returnProof, {
      kind: 'return_delivery',
      evidenceRef: 'queue:return-1:return_enqueued',
    });
  });

  it('replaces a grounded existing-standing task lease only from its persisted owner thread', async () => {
    const taskPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task-1',
      predicate: { kind: 'task_done' },
    });
    const currentLease = {
      leaseId: 'lease-task-1',
      key: 'user-1\u001fsubject:task:task-1\u001fimplement\u001fimplementer',
      generation: 1,
      status: 'replaceable',
      mode: 'single',
      holderCatIds: ['codex-sol'],
      claimOrigin: 'existing_standing',
      holderThreadId: 'thread-task',
      issuerStandingEvidenceRef: 'message:original-task-assignment',
      terminalPredicate: taskPredicate,
    };
    const replacedLease = { ...currentLease, generation: 2, status: 'active' };
    const freshnessResolution = {
      status: 'verified',
      evidenceRef: 'task:task-1:active:220',
      freshnessKey: taskPredicate.freshnessKey,
      ownerCatId: 'codex-sol',
      holderThreadId: 'thread-task',
      tenantScope: 'user-1',
    };
    const { service, calls } = harness({
      currentLease,
      freshnessResolution,
      replaceResult: { outcome: 'replaced', lease: replacedLease },
    });
    const action = {
      subjectRef: 'subject:task:task-1',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'message:replacement-grounding',
      terminalPredicate: { kind: 'task_done' },
      replace: { leaseId: 'lease-task-1', expectedGeneration: 1 },
    };

    const result = await service.admit(
      request({
        actorCatId: 'codex-sol',
        sourceThreadId: 'thread-task',
        targetThreadId: 'thread-task',
        holderCatIds: ['codex-sol'],
        dispatchId: 'existing-standing:task-1:g2',
        action,
      }),
    );

    assert.equal(result.admit, true);
    assert.equal(result.outcome, 'replaced');
    assert.equal(calls.replace.length, 1);
    assert.equal(calls.replace[0].input.claimOrigin, 'existing_standing');
    assert.equal(calls.replace[0].input.predecessorCatId, undefined);
    assert.equal(calls.replace[0].input.predecessorThreadId, undefined);
    assert.equal(calls.replace[0].input.issuerStandingEvidenceRef, 'message:replacement-grounding');

    for (const overrides of [
      { actorCatId: 'codex-terra', holderCatIds: ['codex-terra'] },
      { sourceThreadId: 'thread-wrong' },
      { targetThreadId: 'thread-wrong' },
      { tenantScope: 'user-wrong' },
    ]) {
      await assert.rejects(
        () =>
          service.admit(
            request({
              actorCatId: 'codex-sol',
              sourceThreadId: 'thread-task',
              targetThreadId: 'thread-task',
              holderCatIds: ['codex-sol'],
              action,
              ...overrides,
            }),
          ),
        /existing-standing replacement|task standing does not match|must target the authenticated actor only|replacement lease identity mismatch/,
      );
    }
    assert.equal(calls.replace.length, 1);
  });

  it('does not use existing-standing metadata to bypass a structured replacement issuer route', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      status: 'replaceable',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      claimOrigin: 'structured_transfer',
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
    };
    const { service, calls } = harness({
      currentLease,
      replaceResult: { outcome: 'replaced', lease: { ...currentLease, generation: 2 } },
    });

    await assert.rejects(
      () =>
        service.admit(
          request({
            holderCatIds: ['codex-sol'],
            action: {
              ...request().action,
              claimOrigin: 'existing_standing',
              groundingEvidenceRef: 'message:not-the-original-issuer-route',
              replace: { leaseId: 'lease-1', expectedGeneration: 1 },
            },
          }),
        ),
      /replacement claim origin must match the persisted lease/,
    );
    assert.equal(calls.replace.length, 0);
  });

  it('rejects non-exact freshness before replacement', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      status: 'replaceable',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
    };
    for (const { freshnessResolution, expectedStatus } of [
      { freshnessResolution: { status: 'mismatch', reason: 'predicate HEAD is stale' }, expectedStatus: 'mismatch' },
      {
        freshnessResolution: { status: 'insufficient', reason: 'current HEAD unavailable' },
        expectedStatus: 'insufficient',
      },
      {
        freshnessResolution: {
          status: 'verified',
          evidenceRef: 'community:wrong-head',
          freshnessKey: 'review:wrong-head',
        },
        expectedStatus: 'mismatch',
      },
    ]) {
      const { service, calls } = harness({
        currentLease,
        freshnessResolution,
        replaceResult: { outcome: 'replaced', lease: { ...currentLease, generation: 2 } },
      });

      await assert.rejects(
        () =>
          service.admit(
            request({ action: { ...request().action, replace: { leaseId: 'lease-1', expectedGeneration: 1 } } }),
          ),
        new RegExp(`action successor freshness rejected: ${expectedStatus}`),
      );
      assert.equal(calls.resolveFreshness.length, 1);
      assert.equal(calls.replace.length, 0);
    }
  });

  it('rejects replacement when the supplied lease belongs to another action', async () => {
    const { service } = harness({
      currentLease: {
        leaseId: 'lease-1',
        key: 'user-1\u001fpr:owner/repo#2868\u001fmerge\u001freviewer',
        generation: 1,
      },
    });
    await assert.rejects(
      () =>
        service.admit(
          request({ action: { ...request().action, replace: { leaseId: 'lease-1', expectedGeneration: 1 } } }),
        ),
      /replacement lease identity mismatch/,
    );
  });

  it('surfaces terminal truth when replacement loses its CAS to a terminal marker', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      status: 'replaceable',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
    };
    const terminal = {
      subjectRef: 'pr:owner/repo#2868',
      state: 'closed',
      evidenceRef: 'github:closed-during-replace',
      observedAt: 101,
    };
    let resolveCalls = 0;
    const { service } = harness({
      resolution: async () => {
        resolveCalls += 1;
        return resolveCalls === 1
          ? { terminal: false, source: 'community_projection', state: 'active' }
          : { terminal: true, source: 'marker', truth: terminal };
      },
      currentLease,
      replaceResult: { outcome: 'subject_terminal', lease: currentLease },
    });

    const result = await service.admit(
      request({ action: { ...request().action, replace: { leaseId: 'lease-1', expectedGeneration: 1 } } }),
    );

    assert.deepEqual(result, { admit: false, outcome: 'subject_terminal', terminal });
    assert.equal(resolveCalls, 2);
  });

  it('returns a rejected single lease only to its persisted predecessor route', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      mode: 'single',
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
    };
    const returnedLease = { ...currentLease, generation: 2, holderCatIds: ['codex-sol'] };
    const { service, calls } = harness({
      currentLease,
      returnResult: { outcome: 'returned', lease: returnedLease },
    });
    const returnRequest = request({
      actorCatId: 'codex-terra',
      sourceThreadId: 'thread-target',
      targetThreadId: 'thread-source',
      holderCatIds: ['codex-sol'],
      dispatchId: 'cross-post:return-1',
      action: {
        ...request().action,
        returnToPredecessor: {
          leaseId: 'lease-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    });

    assert.equal((await service.admit(returnRequest)).outcome, 'returned');
    assert.deepEqual(calls.returnToPredecessor, [
      {
        id: 'lease-1',
        input: {
          expectedGeneration: 1,
          rejectingCatId: 'codex-terra',
          rejectingThreadId: 'thread-target',
          dispatchId: 'cross-post:return-1',
          groundingEvidenceRef: 'grounding:mismatch',
          now: 100,
        },
      },
    ]);

    await assert.rejects(
      () => service.admit({ ...returnRequest, holderCatIds: ['gpt52'] }),
      /must match the persisted predecessor cat/,
    );
    await assert.rejects(
      () => service.admit({ ...returnRequest, sourceThreadId: 'thread-other-session' }),
      /must originate from the persisted holder thread/,
    );
    assert.equal(calls.returnToPredecessor.length, 1);
  });

  it('surfaces terminal truth when return loses its CAS to a terminal marker', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      status: 'active',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
    };
    const terminal = {
      subjectRef: 'pr:owner/repo#2868',
      state: 'merged',
      evidenceRef: 'github:merged-during-return',
      observedAt: 101,
    };
    let resolveCalls = 0;
    const { service } = harness({
      resolution: async () => {
        resolveCalls += 1;
        return resolveCalls === 1
          ? { terminal: false, source: 'community_projection', state: 'active' }
          : { terminal: true, source: 'marker', truth: terminal };
      },
      currentLease,
      returnResult: { outcome: 'subject_terminal', lease: currentLease },
    });

    const result = await service.admit(
      request({
        actorCatId: 'codex-terra',
        sourceThreadId: 'thread-target',
        targetThreadId: 'thread-source',
        holderCatIds: ['codex-sol'],
        dispatchId: 'cross-post:return-terminal-race',
        action: {
          ...request().action,
          returnToPredecessor: {
            leaseId: 'lease-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      }),
    );

    assert.deepEqual(result, { admit: false, outcome: 'subject_terminal', terminal });
    assert.equal(resolveCalls, 2);
  });

  it('confirms return delivery with the returned generation fence', async () => {
    const { service, calls } = harness();
    await service.markReturnedDelivered({
      fence: { leaseId: 'lease-1', generation: 2, dispatchId: 'cross-post:return-1' },
      evidenceRef: 'queue:cross-post:return-1:return_enqueued',
      now: 200,
    });
    assert.deepEqual(calls.markReturnDelivered, [
      {
        id: 'lease-1',
        input: {
          expectedGeneration: 2,
          evidenceRef: 'queue:cross-post:return-1:return_enqueued',
          now: 200,
        },
      },
    ]);
  });

  it('replays the same return request after the generation transition', async () => {
    const currentLease = {
      leaseId: 'lease-1',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 2,
      mode: 'single',
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-source',
      predecessorCatId: 'codex-terra',
      predecessorThreadId: 'thread-target',
      dispatchId: 'cross-post:return-1',
      returnTransitions: [
        {
          outcome: 'rejected_ownership',
          fromGeneration: 1,
          toGeneration: 2,
          rejectingCatId: 'codex-terra',
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-source',
          groundingEvidenceRef: 'grounding:mismatch',
          at: 100,
        },
      ],
    };
    const { service, calls } = harness({
      currentLease,
      returnResult: { outcome: 'replayed', lease: currentLease },
    });

    const result = await service.admit(
      request({
        actorCatId: 'codex-terra',
        sourceThreadId: 'thread-target',
        targetThreadId: 'thread-source',
        holderCatIds: ['codex-sol'],
        dispatchId: 'cross-post:return-1',
        action: {
          ...request().action,
          returnToPredecessor: {
            leaseId: 'lease-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      }),
    );

    assert.equal(result.admit, false);
    assert.equal(result.outcome, 'replayed');
    assert.equal(calls.returnToPredecessor.length, 1);
  });

  it('records a parallel holder rejection without admitting a whole-lease return dispatch', async () => {
    const currentLease = {
      leaseId: 'lease-parallel',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      generation: 1,
      mode: 'parallel',
      holderCatIds: ['codex-terra', 'opus'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      holderOutcomes: {},
    };
    const rejectedLease = {
      ...currentLease,
      holderOutcomes: {
        'codex-terra': {
          outcome: 'rejected_ownership',
          evidenceRef: 'grounding:mismatch',
          at: 100,
        },
      },
    };
    const { service, calls } = harness({
      currentLease,
      returnResult: { outcome: 'parallel_return_unsupported', lease: rejectedLease },
    });

    const result = await service.admit(
      request({
        actorCatId: 'codex-terra',
        sourceThreadId: 'thread-target',
        targetThreadId: 'thread-source',
        holderCatIds: ['codex-sol'],
        action: {
          ...request().action,
          mode: 'parallel',
          parallelIntent: 'independent review',
          returnToPredecessor: {
            leaseId: 'lease-parallel',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      }),
    );

    assert.equal(result.admit, false);
    assert.equal(result.outcome, 'parallel_return_unsupported');
    assert.equal(result.lease.holderOutcomes['codex-terra'].outcome, 'rejected_ownership');
    assert.equal(calls.returnToPredecessor.length, 1);
  });

  it('records queue admission failures as unavailable terminal proof', async () => {
    const { service, calls } = harness();
    await service.markUnavailable({
      fence: { leaseId: 'lease-1', generation: 2, dispatchId: 'multi-mention:req-2' },
      holderCatIds: ['codex-terra', 'opus'],
      evidenceRef: 'queue:multi-mention:req-2:not_enqueued',
      now: 200,
    });

    assert.deepEqual(calls.commitOutcome, [
      {
        id: 'lease-1',
        input: {
          generation: 2,
          catId: 'codex-terra',
          outcome: 'unavailable',
          evidenceRef: 'queue:multi-mention:req-2:not_enqueued',
          now: 200,
        },
      },
      {
        id: 'lease-1',
        input: {
          generation: 2,
          catId: 'opus',
          outcome: 'unavailable',
          evidenceRef: 'queue:multi-mention:req-2:not_enqueued',
          now: 200,
        },
      },
    ]);
    assert.deepEqual(calls.recordOutcome, []);
  });
});
