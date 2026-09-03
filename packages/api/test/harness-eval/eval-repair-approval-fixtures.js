import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import { EvalRepairApprovalService } from '../../dist/infrastructure/harness-eval/eval-repair-approval.js';
import { EvalLifecycleEventSchema } from '../../dist/infrastructure/harness-eval/reeval-closure-schema.js';

export const caseId = `eval-case-v1-${'a'.repeat(64)}`;
export const verdictId = 'f313-friction-finding-1';
export const actionRef = 'case-action:f266:opaque-1';
export const nextActionRef = 'case-action:f266:opaque-2';
export const targetVersion = `repair-target-v1-${'b'.repeat(64)}`;

export const ref = (ownerFeatureId, ownerStateRef, version) => ({
  ownerFeatureId,
  ownerStateRef,
  ...(version ? { version } : {}),
});
export const ownerRef = ref('F313', 'owner:f188:codex-sol');
export const ownerAuthorizationRef = ref('F188', 'authorization:repair:f188:v1');
export const targetVersionRef = {
  ownerFeatureId: 'F188',
  ownerStateRef: 'asset:F188:evidence-reader',
  assetKind: 'feature_component',
  assetId: 'F188:evidence-reader',
  version: targetVersion,
};
export const dispatchRef = ref('F188', 'dispatch:repair-owner:f188');

export function caseAction(overrides = {}) {
  return {
    caseId,
    verdictId,
    domainId: 'eval:friction',
    findingKey: 'evidence-reader',
    analysisDisposition: 'repair',
    approvalRequirement: { kind: 'required', reason: 'repair' },
    findingArtifactRef: 'artifact:f313:finding-1',
    repairTarget: { featureId: 'F188', componentId: 'evidence-reader', version: targetVersion },
    expectedChange: 'Repair exact evidence-reader drilldown behavior',
    costAndRollback: 'One reversible PR; revert the merge commit',
    withdrawalCondition: 'Withdraw if owner truth or exact target changes',
    ...overrides,
  };
}

export class MemoryEventLog {
  constructor() {
    this.bySubject = new Map();
  }

  async read(subjectId) {
    return structuredClone(this.bySubject.get(subjectId) ?? []);
  }

  async listSubjectIds() {
    return [...this.bySubject.keys()];
  }

  async append(event, expectedSequence) {
    const validated = EvalLifecycleEventSchema.parse(event);
    const subjectId = validated.caseId ?? validated.verdictId;
    const events = this.bySubject.get(subjectId) ?? [];
    if (events.some((candidate) => candidate.eventId === validated.eventId)) return { outcome: 'duplicate' };
    if (events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: events.length };
    events.push(structuredClone(validated));
    this.bySubject.set(subjectId, events);
    return { outcome: 'appended', sequence: expectedSequence };
  }
}

export function fixture(overrides = {}) {
  const eventLog = overrides.eventLog ?? new MemoryEventLog();
  const cards = [];
  const custody = overrides.custody ?? { dispatches: new Map(), taskCount: 0, leaseCount: 0 };
  const mutationCount = 0;
  let currentOwner = overrides.ownerSnapshot ?? {
    status: 'resolved',
    ownerRef,
    ownerAuthorizationRef,
    targetVersionRef,
    dispatchRef,
  };
  const actions = new Map([
    [actionRef, caseAction()],
    [nextActionRef, caseAction({ supersedesProposalId: 'placeholder' })],
  ]);
  const service = new EvalRepairApprovalService({
    eventLog,
    epochAuthority: overrides.epochAuthority ?? {
      async authorize() {
        return {
          allowed: true,
          record: {
            producerId: 'F266',
            epoch: 1,
            revision: 3,
            phase: 'v1_active',
            updatedAt: '2026-09-02T00:00:00.000Z',
            cutoverReceiptRef: 'receipt:f266:v1',
          },
        };
      },
    },
    resolveCaseAction: async (candidate) => actions.get(candidate) ?? null,
    resolveOwnerChangeContract: overrides.resolveOwnerChangeContract ?? (async () => structuredClone(currentOwner)),
    approvalIngress: overrides.approvalIngress ?? {
      async publish(draft, store) {
        cards.push(structuredClone(draft));
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: 'F266',
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
          createdAt: draft.createdAt,
        };
        await store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    },
    canonicalRepairDispatcher: overrides.canonicalRepairDispatcher ?? {
      async materialize(input) {
        await overrides.beforeDispatchValidation?.({
          input: structuredClone(input),
          setOwner(value) {
            currentOwner = value;
          },
        });
        if (currentOwner.status === 'blocked') {
          return {
            status: 'blocked',
            reason: currentOwner.reason,
            blockerRef: structuredClone(currentOwner.blockerRef),
          };
        }
        const dispatchSnapshot = {
          ownerRef: input.ownerRef,
          ownerAuthorizationRef: input.ownerAuthorizationRef,
          targetVersionRef: input.targetVersionRef,
          dispatchRef: input.dispatchRef,
        };
        const currentSnapshot = {
          ownerRef: currentOwner.ownerRef,
          ownerAuthorizationRef: currentOwner.ownerAuthorizationRef,
          targetVersionRef: currentOwner.targetVersionRef,
          dispatchRef: currentOwner.dispatchRef,
        };
        if (!isDeepStrictEqual(dispatchSnapshot, currentSnapshot)) {
          return {
            status: 'stale',
            currentSnapshot: structuredClone(currentSnapshot),
            rejectionRef: ref('F188', `dispatch-rejected:${input.dispatchId}`),
          };
        }
        if (!custody.dispatches.has(input.dispatchId)) {
          custody.taskCount += 1;
          custody.leaseCount += 1;
          custody.dispatches.set(input.dispatchId, {
            taskRef: ref('F049', `task:f313:${custody.taskCount}`),
            leaseRef: ref('F167', `lease:f313:${custody.leaseCount}`),
            custodyReceiptRef: ref('F167', `custody:f313:${custody.leaseCount}`),
          });
        }
        return { status: 'materialized', receipt: custody.dispatches.get(input.dispatchId) };
      },
    },
    now: () => '2026-09-02T00:10:00.000Z',
  });
  return {
    service,
    eventLog,
    cards,
    actions,
    counts: () => ({
      proposals: proposalCount(eventLog),
      cards: cards.length,
      tasks: custody.taskCount,
      leases: custody.leaseCount,
      mutations: mutationCount,
    }),
    setOwner(value) {
      currentOwner = value;
    },
  };
}

function proposalCount(eventLog) {
  return [...eventLog.bySubject.values()].flat().filter((event) => event.type === 'approval_proposed').length;
}

export const principal = {
  invocationId: 'invocation-1',
  userId: 'owner-user',
  catId: 'codex-sol',
  threadId: 'thread-f313',
  originMessageId: 'message-origin-1',
};

export async function proposeAndAccept(ctx) {
  const proposed = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
  assert.equal(proposed.status, 'published');
  const accepted = await ctx.service.decide({
    proposalId: proposed.proposalId,
    decision: 'accept',
    reasonCode: 'accepted_as_proposed',
    decidedByUserId: 'owner-user',
  });
  assert.equal(accepted.status, 'accepted');
  return proposed;
}
