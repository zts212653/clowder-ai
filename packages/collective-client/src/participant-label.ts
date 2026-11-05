import { actorDisplayName } from './channel-model.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from './client-types.js';

/** Presentation only. Routing and authority always use the structured recipient. */
export function participantLabel(participant: CollectiveParticipant, roster: readonly CollectiveParticipant[]): string {
  const label = (cat: CollectiveParticipant) => cat.displayLabel?.trim() || cat.displayName;
  const name = label(participant);
  const duplicates = roster.filter((cat) => label(cat) === name && cat.availability === 'declared');
  if (duplicates.length < 2) return name;
  const identity = `${name} · @${participant.catId} · ${participant.humanDisplayName}`;
  const sameIdentity = duplicates.filter(
    (cat) => cat.catId === participant.catId && cat.humanDisplayName === participant.humanDisplayName,
  );
  if (sameIdentity.length < 2) return identity;
  const endpointUnique = sameIdentity.filter((cat) => cat.endpointLabel === participant.endpointLabel).length === 1;
  return `${identity} · ${endpointUnique ? participant.endpointLabel : participant.connectionId}`;
}

export function publicActorLabel(event: CollectiveEventEnvelope, roster: readonly CollectiveParticipant[]): string {
  const actor = event.actor;
  if (actor.kind === 'human') return actor.displayName;
  const cat = roster.find(
    (p) =>
      p.serviceInstanceId === event.serviceInstanceId &&
      p.collectiveId === event.collectiveId &&
      p.connectionId === actor.provenance.connectionId &&
      p.catId === actor.provenance.catId &&
      p.humanId === actor.human.humanId,
  );
  return cat ? participantLabel(cat, roster) : actorDisplayName(event);
}
