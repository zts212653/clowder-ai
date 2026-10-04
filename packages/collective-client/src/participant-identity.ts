import type { CollectiveEventEnvelope, CollectiveParticipant, CollectiveRecipient } from './client-types.js';

export function participantKey(
  participant: Pick<CollectiveParticipant, 'serviceInstanceId' | 'connectionId' | 'catId'>,
) {
  return `${participant.serviceInstanceId}:${participant.connectionId}:${participant.catId}`;
}
export function participantRecipient(participant: CollectiveParticipant): CollectiveRecipient {
  return {
    kind: 'agent',
    humanId: participant.humanId,
    agentId: participant.catId,
    connectionId: participant.connectionId,
    participationRevision: participant.participationRevision,
  };
}

export function mentionSelectionForEvent(
  event: CollectiveEventEnvelope,
  participants: readonly CollectiveParticipant[],
  channelId: string,
): { selection?: { recipient: CollectiveRecipient; label: string }; error?: string } {
  const actor = event.actor;
  if (actor.kind === 'human') {
    return { selection: { recipient: { kind: 'human', humanId: actor.humanId }, label: actor.displayName } };
  }
  const participant = participants.find(
    (item) =>
      item.serviceInstanceId === event.serviceInstanceId &&
      item.collectiveId === event.collectiveId &&
      item.humanId === actor.human.humanId &&
      item.endpointId === actor.provenance.endpointId &&
      item.catId === actor.agent.agentId &&
      item.connectionId === actor.provenance.connectionId &&
      item.catId === actor.provenance.catId &&
      item.availability === 'declared' &&
      item.channelIds.includes(channelId),
  );
  return participant
    ? { selection: { recipient: participantRecipient(participant), label: participant.displayName } }
    : { error: '这只猫当前未在本频道参与。' };
}

export function replySelectionForEvent(
  event: CollectiveEventEnvelope,
  participants: readonly CollectiveParticipant[],
  channelId: string,
  currentHumanId: string,
): ReturnType<typeof mentionSelectionForEvent> {
  if (event.actor.kind === 'human' && event.actor.humanId === currentHumanId)
    return { selection: { recipient: { kind: 'channel' }, label: '' } };
  return mentionSelectionForEvent(event, participants, channelId);
}
