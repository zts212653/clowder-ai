import { createHash } from 'node:crypto';
import type { InteractionEvent, PersonClaimVersion, PersonRelationship } from '@cat-cafe/shared';
import type { PersonMemoryDrillInput } from './PersonMemoryRecallService.js';
import { claimText, eventText, relationshipText } from './person-memory-item-text.js';
import { personClaimOwnerRevision, personInteractionOwnerRevision } from './person-memory-owner-revision.js';

export async function findPersonMemoryDrillItem(
  input: PersonMemoryDrillInput,
  snapshot: { claims: PersonClaimVersion[]; relationships: PersonRelationship[]; events: InteractionEvent[] },
): Promise<{
  recordedAt: number;
  revision: string;
  text: string;
  source:
    | { kind: 'message'; sourceRef: { kind: 'message'; threadId: string; messageId: string } }
    | { kind: 'owner_memory_action' };
} | null> {
  if (input.item.kind === 'claim') {
    const claim = snapshot.claims.find(
      (candidate) => candidate.claimId === input.item.id && candidate.status !== 'redacted',
    );
    if (!claim) return null;
    if (claim.materializedBy.kind === 'owner_memory_action') {
      return {
        revision: personClaimOwnerRevision(claim),
        recordedAt: claim.recordedAt,
        text: claimText(claim),
        source: { kind: 'owner_memory_action' },
      };
    }
    const sourceRef = claim.sourceRefs[0];
    return sourceRef
      ? {
          revision: personClaimOwnerRevision(claim),
          recordedAt: claim.recordedAt,
          text: claimText(claim),
          source: { kind: 'message', sourceRef },
        }
      : null;
  }
  if (input.item.kind === 'relationship') {
    const relationship = snapshot.relationships.find((candidate) => candidate.relationshipId === input.item.id);
    const sourceRef = relationship?.sourceRefs[0];
    return relationship && sourceRef
      ? {
          revision: `sha256:${createHash('sha256').update(JSON.stringify(relationship)).digest('hex')}`,
          recordedAt: relationship.transitions.at(-1)?.recordedAt ?? relationship.createdAt,
          text: relationshipText(relationship),
          source: { kind: 'message', sourceRef },
        }
      : null;
  }
  const event = snapshot.events.find(
    (candidate) => candidate.eventId === input.item.id && candidate.status !== 'redacted',
  );
  if (!event) return null;
  if (event.materializedBy.kind === 'owner_memory_action') {
    return {
      revision: personInteractionOwnerRevision(event),
      recordedAt: event.recordedAt,
      text: eventText(event),
      source: { kind: 'owner_memory_action' },
    };
  }
  const sourceRef = event.sourceRefs[0];
  return sourceRef
    ? {
        revision: personInteractionOwnerRevision(event),
        recordedAt: event.recordedAt,
        text: eventText(event),
        source: { kind: 'message', sourceRef },
      }
    : null;
}
