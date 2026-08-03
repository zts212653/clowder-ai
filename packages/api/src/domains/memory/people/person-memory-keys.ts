function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function encodeAlias(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function normalizePrivateAlias(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

export const PersonMemoryKeys = {
  candidate: (ownerUserId: string, candidateId: string) =>
    `person-memory:candidate:${encodePart(ownerUserId)}:${encodePart(candidateId)}`,
  candidateOwner: (candidateId: string) => `person-memory:candidate-owner:${encodePart(candidateId)}`,
  pending: (ownerUserId: string) => `person-memory:pending:${encodePart(ownerUserId)}`,
  decision: (ownerUserId: string, candidateId: string, decisionId: string) =>
    `person-memory:decision:${encodePart(ownerUserId)}:${encodePart(candidateId)}:${encodePart(decisionId)}`,
  undo: (ownerUserId: string, candidateId: string, requestId: string) =>
    `person-memory:undo:${encodePart(ownerUserId)}:${encodePart(candidateId)}:${encodePart(requestId)}`,
  candidateDecisions: (ownerUserId: string, candidateId: string) =>
    `person-memory:candidate-decisions:${encodePart(ownerUserId)}:${encodePart(candidateId)}`,
  candidatePerson: (ownerUserId: string, candidateId: string) =>
    `person-memory:candidate-person:${encodePart(ownerUserId)}:${encodePart(candidateId)}`,
  person: (ownerUserId: string, personId: string) =>
    `person-memory:person:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  alias: (ownerUserId: string, normalizedAlias: string) =>
    `person-memory:alias:${encodePart(ownerUserId)}:${encodeAlias(normalizedAlias)}`,
  workspaceEntityPerson: (ownerUserId: string, entityRef: string) =>
    `person-memory:workspace-entity-person:${encodePart(ownerUserId)}:${encodePart(entityRef)}`,
  personCandidates: (ownerUserId: string, personId: string) =>
    `person-memory:person-candidates:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  targetCandidates: (ownerUserId: string, personId: string) =>
    `person-memory:target-candidates:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  claim: (ownerUserId: string, claimId: string) =>
    `person-memory:claim:${encodePart(ownerUserId)}:${encodePart(claimId)}`,
  personClaims: (ownerUserId: string, personId: string) =>
    `person-memory:person-claims:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  currentClaim: (ownerUserId: string, personId: string, predicate: string) =>
    `person-memory:current-claim:${encodePart(ownerUserId)}:${encodePart(personId)}:${encodeAlias(predicate)}`,
  relationship: (ownerUserId: string, relationshipId: string) =>
    `person-memory:relationship:${encodePart(ownerUserId)}:${encodePart(relationshipId)}`,
  personRelationships: (ownerUserId: string, personId: string) =>
    `person-memory:person-relationships:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  primaryRelationship: (ownerUserId: string, personId: string) =>
    `person-memory:primary-relationship:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  event: (ownerUserId: string, eventId: string) =>
    `person-memory:event:${encodePart(ownerUserId)}:${encodePart(eventId)}`,
  personEvents: (ownerUserId: string, personId: string) =>
    `person-memory:person-events:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  relationshipEvents: (ownerUserId: string, relationshipId: string) =>
    `person-memory:relationship-events:${encodePart(ownerUserId)}:${encodePart(relationshipId)}`,
  correction: (ownerUserId: string, requestId: string) =>
    `person-memory:correction:${encodePart(ownerUserId)}:${encodePart(requestId)}`,
  amendment: (ownerUserId: string, requestId: string) =>
    `person-memory:amendment:${encodePart(ownerUserId)}:${encodePart(requestId)}`,
  redaction: (ownerUserId: string, requestId: string) =>
    `person-memory:redaction:${encodePart(ownerUserId)}:${encodePart(requestId)}`,
  personArtifacts: (ownerUserId: string, personId: string) =>
    `person-memory:person-artifacts:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  forgetFence: (ownerUserId: string, personId: string) =>
    `person-memory:forget-fence:${encodePart(ownerUserId)}:${encodePart(personId)}`,
  forgetReceipt: (ownerUserId: string, requestId: string) =>
    `person-memory:forget-receipt:${encodePart(ownerUserId)}:${encodePart(requestId)}`,
  proposalForgetFence: (ownerUserId: string, rootCandidateId: string) =>
    `person-memory:proposal-forget-fence:${encodePart(ownerUserId)}:${encodePart(rootCandidateId)}`,
  proposalForgetReceipt: (ownerUserId: string, proposalId: string, requestId: string) =>
    `person-memory:proposal-forget-receipt:${encodePart(ownerUserId)}:${encodePart(proposalId)}:${encodePart(requestId)}`,
  suppression: (ownerUserId: string, candidateId: string) =>
    `person-memory:suppression:${encodePart(ownerUserId)}:${encodePart(candidateId)}`,
  suppressionSubject: (ownerUserId: string, normalizedSubject: string) =>
    `person-memory:suppression-subject:${encodePart(ownerUserId)}:${encodeAlias(normalizedSubject)}`,
  dispositionLineageBinding: (ownerUserId: string, rootCandidateId: string) =>
    `person-memory:disposition-lineage:${encodePart(ownerUserId)}:${encodePart(rootCandidateId)}`,
  dispositionLineageHandleLocator: (ownerUserId: string, opaqueLineageHandle: string) =>
    `person-memory:disposition-lineage-handle:${encodePart(ownerUserId)}:${encodePart(opaqueLineageHandle)}`,
  dispositionDecisionReceiptLocator: (ownerUserId: string, opaqueDecisionReceiptHandle: string) =>
    `person-memory:disposition-receipt:${encodePart(ownerUserId)}:${encodePart(opaqueDecisionReceiptHandle)}`,
} as const;
