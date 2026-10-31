import { ownerTruthRefV1Schema } from '@cat-cafe/shared';

export function evalRepairCaseRef(caseId: string, verdictId: string) {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F266',
    ownerStateRef: `eval-case:${caseId}`,
    version: verdictId,
  });
}

export function evalRepairProposalRef(proposalId: string) {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F266',
    ownerStateRef: `eval-repair-proposal:${proposalId}`,
  });
}

export function evalRepairSupersessionDecisionRef(proposalId: string, occurredAt: string) {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F266',
    ownerStateRef: `eval-repair-supersession:${proposalId}`,
    version: occurredAt,
  });
}
