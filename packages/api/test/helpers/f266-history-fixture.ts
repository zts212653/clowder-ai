import { EvalLifecycleEventSchema } from '../../src/infrastructure/harness-eval/reeval-closure-schema.js';

export const snapshot = {
  ownerRef: { ownerFeatureId: 'F313', ownerStateRef: 'owner:history' },
  ownerAuthorizationRef: { ownerFeatureId: 'F188', ownerStateRef: 'authorization:history' },
  targetVersionRef: {
    ownerFeatureId: 'F188',
    ownerStateRef: 'asset:history',
    assetKind: 'feature_component',
    assetId: 'F188:history',
    version: `repair-target-v1-${'b'.repeat(64)}`,
  },
  dispatchRef: { ownerFeatureId: 'F188', ownerStateRef: 'dispatch:history' },
};
export function plainEvent(id: string, subject = 'long-subject') {
  return EvalLifecycleEventSchema.parse({
    eventId: id,
    verdictId: 'verdict',
    caseId: subject,
    domainId: 'eval:friction',
    type: 'verdict_cycle_observed',
    actor: { kind: 'cat', id: 'codex61-sol' },
    occurredAt: '2026-10-27T12:00:00.000Z',
    cycleCreatedAt: '2026-10-27T12:00:00.000Z',
    reason: 'history fixture',
    refs: [{ kind: 'verdict', availability: 'available', value: 'fixture:history' }],
  });
}
export function approvalEvents(proposalId: string, subject = 'long-subject', owner = 'owner') {
  const { cycleCreatedAt: _unused, ...base } = plainEvent(`${proposalId}:proposed`, subject) as Extract<
    ReturnType<typeof plainEvent>,
    { type: 'verdict_cycle_observed' }
  >;
  const proposed = EvalLifecycleEventSchema.parse({
    ...base,
    type: 'approval_proposed',
    proposalId,
    caseActionRef: `action:${proposalId}`,
    requestIdempotencyRef: `idempotency:${proposalId}`,
    requestedAuthority: 'repair',
    findingArtifactRef: 'artifact:history',
    expectedChange: 'Repair reader',
    costAndRollback: 'Revert',
    withdrawalCondition: 'Owner changes',
    summary: `Subject ${proposalId}`,
    detail: {},
    requestOrigin: {
      invocationId: 'inv',
      threadId: 'source',
      messageId: `origin:${proposalId}`,
      requesterCatId: 'codex61-sol',
      ownerUserId: owner,
    },
    requestSnapshot: snapshot,
  });
  const anchored = EvalLifecycleEventSchema.parse({
    ...base,
    eventId: `${proposalId}:anchored`,
    type: 'approval_anchored',
    proposalId,
    approvalEnvelopeRef: `envelope:${proposalId}`,
    approvalCardRef: { threadId: 'source', messageId: `card:${proposalId}` },
  });
  const decided = EvalLifecycleEventSchema.parse({
    ...base,
    eventId: `${proposalId}:decided`,
    type: 'approval_decided',
    proposalId,
    resolution: 'accepted',
    decisionKind: 'accept',
    reasonCode: 'accepted_as_proposed',
    decidedByUserId: owner,
    approvalRef: { ownerFeatureId: 'F266', ownerStateRef: `approval:${proposalId}` },
    requestSnapshot: snapshot,
  });
  return [proposed, anchored, decided];
}
