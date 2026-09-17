const owner = (ownerFeatureId, ownerStateRef) => ({ ownerFeatureId, ownerStateRef });

const targetVersion = {
  ownerFeatureId: 'F202',
  ownerStateRef: 'skill:video-forge',
  assetKind: 'skill',
  assetId: 'video-forge',
  version: 'v1',
};

const changedVersion = { ...targetVersion, version: 'v2' };

export async function appendCycleEvent(eventLog, programId, expectedSequence, event) {
  await eventLog.append({
    schemaVersion: 1,
    eventId: `evolution-event:cycle:${expectedSequence}`,
    programId,
    expectedSequence,
    clientMessageId: `cycle:${expectedSequence}`,
    actorRef: 'cat:codex-sol',
    originRef: `thread:f311:message:cycle:${expectedSequence}`,
    occurredAt: `2026-09-01T00:00:${String(expectedSequence).padStart(2, '0')}.000Z`,
    event,
  });
}

export async function appendTunedChangeCycle(eventLog, programId, expectedSequence) {
  const events = [
    {
      type: 'intervention_linked',
      interventionCardRef: owner('F267', 'intervention-card:execution-1'),
      interventionLayerRef: owner('F267', 'intervention-layer:execution'),
      gateReceiptRef: owner('F267', 'intervention-gate:opened-1'),
    },
    {
      type: 'change_cycle_linked',
      caseRef: owner('F266', 'eval-repair-case:1'),
      proposalRef: owner('F266', 'eval-repair-proposal:1'),
      ownerAuthorizationRef: owner('F202', 'execution-permission:video-forge-v2'),
      targetVersionRef: targetVersion,
    },
    {
      type: 'approval_linked',
      approvalRef: owner('F246', 'approval:1'),
      targetVersionRef: targetVersion,
    },
    {
      type: 'intervention_receipt_linked',
      result: 'changed',
      interventionReceiptRef: owner('F202', 'mutation-receipt:1'),
      assetVersionRef: changedVersion,
      loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v2'),
    },
    {
      type: 'outcome_linked',
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:1'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-load-1'),
    },
    {
      type: 'decision_recorded',
      decision: 'tune',
      decisionRef: owner('F266', 'eval-repair-decision:tune-1'),
    },
  ];
  for (const [offset, event] of events.entries()) {
    await appendCycleEvent(eventLog, programId, expectedSequence + offset, event);
  }
}
