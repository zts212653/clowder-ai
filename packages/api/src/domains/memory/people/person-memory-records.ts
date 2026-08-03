import {
  humanDispositionFeedbackInputSchema,
  humanDispositionLedgerEntrySchema,
  type InteractionEvent,
  interactionEventIdSchema,
  interactionEventSchema,
  type PersonClaimVersion,
  type PersonIdentity,
  type PersonRelationship,
  personClaimIdSchema,
  personClaimVersionSchema,
  personIdentitySchema,
  personIdSchema,
  personRelationshipIdSchema,
  personRelationshipSchema,
} from '@cat-cafe/shared';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

export function parseStoredCandidate(raw: string | null): StoredPersonMemoryCandidate | null {
  if (!raw) return null;
  const candidate = JSON.parse(raw) as StoredPersonMemoryCandidate;
  if (candidate.latestHumanDisposition) {
    candidate.latestHumanDisposition = humanDispositionFeedbackInputSchema.parse(candidate.latestHumanDisposition);
  }
  if (candidate.humanDispositionLedgerEntry) {
    candidate.humanDispositionLedgerEntry = humanDispositionLedgerEntrySchema.parse(
      candidate.humanDispositionLedgerEntry,
    );
  }
  if (
    candidate.dispositionLineageBindingKey !== undefined &&
    (typeof candidate.dispositionLineageBindingKey !== 'string' ||
      candidate.dispositionLineageBindingKey.trim().length === 0)
  ) {
    throw new Error('invalid F276 disposition lineage binding key');
  }
  return candidate;
}

export function parsePerson(raw: string | null): PersonIdentity | null {
  if (!raw) return null;
  return personIdentitySchema.parse(JSON.parse(raw));
}

export function parseClaim(raw: string | null): PersonClaimVersion | null {
  if (!raw) return null;
  return personClaimVersionSchema.parse(JSON.parse(raw));
}

export function parseRelationship(raw: string | null): PersonRelationship | null {
  if (!raw) return null;
  return personRelationshipSchema.parse(JSON.parse(raw));
}

export function parseEvent(raw: string | null): InteractionEvent | null {
  if (!raw) return null;
  return interactionEventSchema.parse(JSON.parse(raw));
}

function safeSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_');
}

export function personIdForCandidate(candidateId: string) {
  return personIdSchema.parse(`person_${safeSuffix(candidateId.replace(/^person_candidate_/, ''))}`);
}

export function relationshipIdForPerson(personId: string) {
  return personRelationshipIdSchema.parse(`relationship_${safeSuffix(personId.replace(/^person_/, ''))}`);
}

export function claimIdForDraft(candidateId: string, draftId: string) {
  const candidateSuffix = safeSuffix(candidateId.replace(/^person_candidate_/, ''));
  const draftSuffix = safeSuffix(draftId.replace(/^person_draft_/, ''));
  return personClaimIdSchema.parse(`person_claim_${candidateSuffix}:${draftSuffix}`);
}

export function eventIdForDraft(candidateId: string, draftId: string) {
  const candidateSuffix = safeSuffix(candidateId.replace(/^person_candidate_/, ''));
  const draftSuffix = safeSuffix(draftId.replace(/^person_draft_/, ''));
  return interactionEventIdSchema.parse(`person_event_${candidateSuffix}:${draftSuffix}`);
}

export function correctionClaimId(personId: string, requestId: string) {
  return personClaimIdSchema.parse(
    `person_claim_${safeSuffix(personId.replace(/^person_/, ''))}:correction:${safeSuffix(requestId)}`,
  );
}

export function retirementClaimId(personId: string, requestId: string) {
  return personClaimIdSchema.parse(
    `person_claim_${safeSuffix(personId.replace(/^person_/, ''))}:retirement:${safeSuffix(requestId)}`,
  );
}

export function amendmentEventId(personId: string, requestId: string) {
  return interactionEventIdSchema.parse(
    `person_event_${safeSuffix(personId.replace(/^person_/, ''))}:amendment:${safeSuffix(requestId)}`,
  );
}
