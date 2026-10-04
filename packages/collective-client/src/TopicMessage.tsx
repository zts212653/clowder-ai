import { actorDisplayName, actorOrigin, formatEventTime } from './channel-model.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from './client-types.js';
import { MemberAvatar } from './MemberAvatar.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { authorPresentation } from './message-presentation.js';
import { useRoomPresentation } from './use-room-presentation.js';

export function MessageAvatar({
  event,
  participants = [],
  compact = false,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly compact?: boolean;
}) {
  const actor = event.actor;
  const card =
    actor.kind === 'agent'
      ? participants.find(
          (participant) =>
            participant.serviceInstanceId === event.serviceInstanceId &&
            participant.connectionId === actor.provenance.connectionId &&
            participant.catId === actor.provenance.catId,
        )
      : undefined;
  return (
    <MemberAvatar
      name={actorDisplayName(event)}
      kind={event.actor.kind}
      avatarUrl={event.actor.kind === 'human' ? event.actor.avatarUrl : card?.avatarDataUrl}
      compact={compact}
    />
  );
}

export function MessageBody({
  event,
  participants = [],
  responseState,
  namedResponseState,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly responseState?: 'waiting' | 'responded';
  readonly namedResponseState?: 'waiting' | 'responded';
}) {
  const recipient = event.recipient?.kind === 'agent' ? event.recipient : undefined;
  const namedCat = recipient
    ? participants.find(
        (participant) =>
          participant.serviceInstanceId === event.serviceInstanceId &&
          participant.connectionId === recipient.connectionId &&
          participant.humanId === recipient.humanId &&
          participant.catId === recipient.agentId,
      )
    : undefined;
  return (
    <>
      <MessageMarkdown source={event.body} />
      {recipient && (
        <p className="named-recipient">
          点名 <strong>@{namedCat?.displayName ?? recipient.agentId}</strong>
          {namedResponseState === 'waiting'
            ? ' · 尚无公开回复'
            : namedResponseState === 'responded'
              ? ' · 已在原处回复'
              : ''}
        </p>
      )}
      {event.attentionRequest && (
        <p className="request-kind">
          希望伙伴回应
          {responseState === 'waiting' ? ' · 尚未有人回应' : responseState === 'responded' ? ' · 已有回应' : ''}
        </p>
      )}
      {event.workRequest && <p className="request-kind">请求持续处理</p>}
    </>
  );
}

/**
 * F322 B segment 1 (human message), shared-room half — another person's nameplate (DESIGN.md「对话」): the same small
 * plate a cat gets, in the human colour (`--color-cocreator-*`, the one colour every person shares). A 16px avatar and the
 * name, from the original event. Where the member panel can be opened the plate is its button.
 */
export function HumanNameplate({
  event,
  participants = [],
  onOpenMember,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly onOpenMember?: (event: CollectiveEventEnvelope) => void;
}) {
  const name = actorDisplayName(event);
  const face = (
    <>
      <MessageAvatar event={event} participants={participants} compact />
      <strong>{name}</strong>
    </>
  );
  return onOpenMember ? (
    <button
      type="button"
      className="human-nameplate"
      title={actorOrigin(event)}
      aria-label={`查看 ${name}`}
      onClick={() => onOpenMember(event)}
    >
      {face}
    </button>
  ) : (
    <span className="human-nameplate" title={actorOrigin(event)}>
      {face}
    </span>
  );
}

export function TopicMessage({
  event,
  participants = [],
  onOpenMember,
  currentHumanId,
  presentation,
  showTime = true,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly onOpenMember?: (event: CollectiveEventEnvelope) => void;
  /** The viewer (`snapshot.me.human.humanId`). Without it nothing is "yours": a person is on the left, named. */
  readonly currentHumanId?: string;
  /** Overrides the frame default (tests, previews). */
  readonly presentation?: 'v2' | 'classic';
  /** Self messages only: the time under the block, once per run. */
  readonly showTime?: boolean;
}) {
  const v2 = useRoomPresentation(presentation) === 'v2';
  const author = authorPresentation(event, currentHumanId);
  if (v2 && author === 'self') {
    return (
      <article className="topic-message topic-message-self" data-author="self">
        <div className="message-bubble">
          <MessageBody event={event} participants={participants} />
        </div>
        {showTime && (
          <time className="message-time" dateTime={event.acceptedAt}>
            {formatEventTime(event.acceptedAt)}
          </time>
        )}
      </article>
    );
  }
  if (v2 && author === 'other-human') {
    return (
      <article className="topic-message topic-message-other" data-author="other-human">
        <div>
          <header className="message-plate-row">
            <HumanNameplate event={event} participants={participants} onOpenMember={onOpenMember} />
            <time dateTime={event.acceptedAt}>{formatEventTime(event.acceptedAt)}</time>
          </header>
          <MessageBody event={event} participants={participants} />
        </div>
      </article>
    );
  }
  return (
    <article className="topic-message">
      {onOpenMember ? (
        <button
          type="button"
          className="avatar-button"
          onClick={() => onOpenMember(event)}
          aria-label={`查看 ${actorDisplayName(event)}`}
        >
          <MessageAvatar event={event} participants={participants} compact />
        </button>
      ) : (
        <MessageAvatar event={event} participants={participants} compact />
      )}
      <div>
        <header className="message-meta">
          <strong>{actorDisplayName(event)}</strong>
          <time dateTime={event.acceptedAt}>{formatEventTime(event.acceptedAt)}</time>
        </header>
        <MessageBody event={event} participants={participants} />
      </div>
    </article>
  );
}
