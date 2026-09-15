import type { CollectiveParticipant, CollectiveRecipient } from './client-types.js';

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
export function participantLabel(participant: CollectiveParticipant) {
  return `${participant.displayName} · ${participant.humanDisplayName} · ${participant.endpointLabel} (${participant.endpointId.slice(-6)})`;
}
export function ParticipantPicker({
  participants,
  channelId,
  recipient,
  onChange,
}: {
  readonly participants: readonly CollectiveParticipant[];
  readonly channelId: string;
  readonly recipient: CollectiveRecipient;
  readonly onChange: (recipient: CollectiveRecipient) => void;
}) {
  const selected = participants.find(
    (item) =>
      recipient.kind === 'agent' &&
      item.connectionId === recipient.connectionId &&
      item.catId === recipient.agentId &&
      item.humanId === recipient.humanId &&
      item.participationRevision === recipient.participationRevision &&
      item.availability === 'declared' &&
      item.channelIds.includes(channelId),
  );
  const stale = recipient.kind === 'agent' && !selected;
  return (
    <label className="participant-picker">
      请求谁回应
      <select
        value={selected ? participantKey(selected) : stale ? 'stale' : recipient.kind === 'human' ? 'human' : ''}
        onChange={(event) => {
          const participant = participants.find((item) => participantKey(item) === event.target.value);
          if (participant) onChange(participantRecipient(participant));
          else if (!event.target.value) onChange({ kind: 'channel' });
        }}
      >
        <option value="">发到频道</option>
        {stale && (
          <option value="stale" disabled>
            参与设置已变化，请重新选择
          </option>
        )}
        {recipient.kind === 'human' && <option value="human">当前消息的发言者</option>}
        {participants
          .filter((item) => item.channelIds.includes(channelId))
          .map((item) => (
            <option key={participantKey(item)} value={participantKey(item)} disabled={item.availability !== 'declared'}>
              {participantLabel(item)}
              {item.availability !== 'declared' ? ' · 已退出' : ''}
            </option>
          ))}
      </select>
    </label>
  );
}
