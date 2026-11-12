export const owner = 'owner-maintenance';
export const personId = 'person_owner_maintenance';
export const origin = 'http://localhost:3003';
export const auth = { origin, 'x-test-session': owner, 'x-csrf-token': 'csrf-maintenance' };
export const source = { kind: 'message', threadId: 'thread-maintenance', messageId: 'message-maintenance' };
export const authority = {
  kind: 'card_approval',
  candidateId: 'person_candidate_maintenance',
  draftId: 'person_draft_maintenance',
  authorizedAt: 10,
};
export const claim = {
  claimId: 'person_claim_maintenance',
  personId,
  ownerUserId: owner,
  payload: { kind: 'reported_fact', predicate: 'team', value: 'private team', assertedBy: 'owner' },
  status: 'current',
  recordedAt: 10,
  sourceRefs: [source],
  materializedBy: authority,
};
export const relationship = {
  relationshipId: 'relationship_maintenance',
  personId,
  ownerUserId: owner,
  status: 'current',
  createdAt: 10,
  materializedBy: authority,
  sourceRefs: [source],
  transitions: [{ status: 'current', recordedAt: 10, materializedBy: authority, sourceRefs: [source] }],
};
export const event = {
  eventId: 'person_event_maintenance',
  relationshipId: relationship.relationshipId,
  ownerUserId: owner,
  eventKind: 'meeting',
  headline: 'private meeting',
  status: 'active',
  recordedAt: 10,
  sourceRefs: [source],
  materializedBy: authority,
};
export const requestId = `maintenance_${'a'.repeat(32)}`;
