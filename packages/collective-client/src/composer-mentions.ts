import type { CollectiveParticipant, CollectiveRecipient } from './client-types.js';
import { participantKey, participantRecipient } from './participant-identity.js';
import { participantLabel } from './participant-label.js';

export interface HumanMention {
  readonly humanId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}
export interface MentionSelection {
  readonly recipient: CollectiveRecipient;
  readonly label: string;
}
export function selectionAvailable(
  recipient: CollectiveRecipient,
  participants: readonly CollectiveParticipant[],
  humans: readonly HumanMention[],
  channelId: string,
) {
  if (recipient.kind === 'human') return humans.some((human) => human.humanId === recipient.humanId);
  return (
    recipient.kind !== 'agent' ||
    participants.some(
      (item) =>
        item.connectionId === recipient.connectionId &&
        item.catId === recipient.agentId &&
        item.humanId === recipient.humanId &&
        item.participationRevision === recipient.participationRevision &&
        item.availability === 'declared' &&
        item.channelIds.includes(channelId),
    )
  );
}

export function composerMentionOptions(
  participants: readonly CollectiveParticipant[],
  humans: readonly HumanMention[],
  channelId: string,
  query: string,
  humanLabel: string,
) {
  return [
    ...participants
      .filter((item) => item.availability === 'declared' && item.channelIds.includes(channelId))
      .map((item) => ({
        key: participantKey(item),
        label: participantLabel(item, participants),
        detail: `${item.humanDisplayName} · ${item.endpointLabel} (${item.endpointId.slice(-6)})`,
        recipient: participantRecipient(item),
        kind: 'agent' as const,
        avatarUrl: item.avatarDataUrl,
      })),
    ...humans.map((human) => ({
      key: human.humanId,
      label: human.displayName,
      detail: humanLabel,
      recipient: { kind: 'human' as const, humanId: human.humanId },
      kind: 'human' as const,
      avatarUrl: human.avatarUrl,
    })),
  ].filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query));
}
