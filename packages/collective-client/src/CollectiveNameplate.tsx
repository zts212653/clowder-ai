import { Nameplate } from '@cat-cafe/ui';
import { actorDisplayName } from './channel-model.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from './client-types.js';
import { participantLabel } from './participant-label.js';
import { MessageAvatar } from './TopicMessage.js';

export function CollectiveNameplate({
  event,
  participants,
  onOpen,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants: readonly CollectiveParticipant[];
  readonly onOpen?: () => void;
}) {
  const actor = event.actor;
  const id = actor.kind === 'agent' ? actor.provenance.catId : actor.humanId;
  const safeId = /^[a-zA-Z0-9_-]+$/.test(id) ? id : 'cocreator';
  const participant =
    actor.kind === 'agent'
      ? participants.find(
          (p) =>
            p.serviceInstanceId === event.serviceInstanceId &&
            p.collectiveId === event.collectiveId &&
            p.connectionId === actor.provenance.connectionId &&
            p.catId === actor.provenance.catId &&
            p.humanId === actor.human.humanId,
        )
      : undefined;
  const label = participant ? participantLabel(participant, participants) : actorDisplayName(event);
  const human = actor.kind === 'human';
  return (
    <Nameplate
      id={id}
      name={label}
      kind={human ? 'human' : 'cat'}
      surface={human ? 'var(--human-surface)' : `var(--color-${safeId}-surface, var(--shell-selected))`}
      ink={human ? 'var(--human-name)' : `var(--color-${safeId}-text, var(--shell-ink))`}
      title={
        actor.kind === 'agent'
          ? `${actorDisplayName(event)} · ${actor.human.displayName} · @${id}`
          : actorDisplayName(event)
      }
      avatar={
        onOpen ? (
          <button
            type="button"
            className="avatar-button"
            onClick={onOpen}
            aria-label={`查看 ${actorDisplayName(event)}`}
          >
            <MessageAvatar event={event} participants={participants} />
          </button>
        ) : (
          <MessageAvatar event={event} participants={participants} />
        )
      }
    />
  );
}
