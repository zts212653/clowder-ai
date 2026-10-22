import { AppTooltip } from '@cat-cafe/ui';
import { CollectiveNameplate } from './CollectiveNameplate.js';
import { actorDisplayName, formatEventTime } from './channel-model.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { MemberAvatar } from './MemberAvatar.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { authorPresentation } from './message-presentation.js';
import { participantLabel } from './participant-label.js';
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
            participant.collectiveId === event.collectiveId &&
            participant.humanId === actor.human.humanId &&
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
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly responseState?: 'waiting' | 'responded';
}) {
  const t = useCollectiveText();
  const recipient = event.recipient?.kind === 'agent' ? event.recipient : undefined;
  const namedCat = recipient
    ? participants.find(
        (participant) =>
          participant.serviceInstanceId === event.serviceInstanceId &&
          participant.collectiveId === event.collectiveId &&
          participant.connectionId === recipient.connectionId &&
          participant.humanId === recipient.humanId &&
          participant.catId === recipient.agentId,
      )
    : undefined;
  return (
    <>
      <MessageMarkdown
        source={event.body}
        prefix={
          recipient ? (
            <AppTooltip
              label={
                namedCat
                  ? `${namedCat.displayName} · ${namedCat.humanDisplayName} · @${namedCat.catId}`
                  : `@${recipient.agentId}`
              }
              intent="content"
              side="top"
            >
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals the exact recipient identity tooltip without introducing a new action. */}
              <span className="message-inline-mention" tabIndex={0}>
                @{namedCat ? participantLabel(namedCat, participants) : recipient.agentId}
              </span>
            </AppTooltip>
          ) : undefined
        }
      />
      {event.attentionRequest && (
        <p className="request-kind">
          {t('希望伙伴回应')}
          {responseState === 'waiting'
            ? ` · ${t('尚未有人回应')}`
            : responseState === 'responded'
              ? ` · ${t('已有回应')}`
              : ''}
        </p>
      )}
      {event.workRequest && <p className="request-kind">{t('请求持续处理')}</p>}
    </>
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
  /** Time visibility supplied by the surrounding flow; consecutive own messages show it once. */
  readonly showTime?: boolean;
}) {
  const language = useCollectiveLanguage();
  const v2 = useRoomPresentation(presentation) === 'v2';
  const author = authorPresentation(event, currentHumanId);
  return (
    <article className="topic-message" data-author={v2 ? author : undefined}>
      <div>
        <header className="message-meta">
          <CollectiveNameplate
            event={event}
            participants={participants}
            onOpen={onOpenMember ? () => onOpenMember(event) : undefined}
          />
          {(!v2 || showTime) && (
            <time className={v2 ? 'message-time' : undefined} dateTime={event.acceptedAt}>
              {formatEventTime(event.acceptedAt, language)}
            </time>
          )}
        </header>
        <MessageBody event={event} participants={participants} />
      </div>
    </article>
  );
}
