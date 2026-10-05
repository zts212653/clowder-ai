import type { RoadmapAction } from './channel-collaboration.js';
import { actorDisplayName, actorOrigin, formatEventTime } from './channel-model.js';
import type {
  ChannelThread,
  CollectiveEventEnvelope,
  CollectiveParticipant,
  CollectiveReactionEmoji,
  CollectiveReactionSummary,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
} from './client-types.js';
import { MessageInteraction } from './MessageInteraction.js';
import { authorPresentation } from './message-presentation.js';
import { HumanNameplate, MessageAvatar, MessageBody } from './TopicMessage.js';
import { useRoomPresentation } from './use-room-presentation.js';
import type { InformalVoteDraft } from './VoteCard.js';

export function ChannelMessage({
  thread,
  onOpenTopic,
  onMention,
  onOpenMember,
  works = [],
  votes = [],
  allWorks = [],
  currentHumanId,
  canSteward = false,
  participants = [],
  humanNames = {},
  reactions = [],
  onProposeWork,
  onCommitWork,
  onDeclineWork,
  onAcceptWorkResult,
  onRequestWorkRevision,
  onCompleteWork,
  onCreateVote,
  onCastVote,
  onCloseVote,
  roadmapActions,
  onSetReaction,
  highlighted = false,
  presentation,
  showTime = true,
}: ChannelMessageProps) {
  const v2 = useRoomPresentation(presentation) === 'v2';
  const author = authorPresentation(thread.root, currentHumanId);
  const { root, replies } = thread;
  const namedRecipient = root.recipient?.kind === 'agent' ? root.recipient : undefined;
  const namedResponded = namedRecipient
    ? replies.some(
        (reply) =>
          reply.replyToEventId === root.eventId &&
          reply.actor.kind === 'agent' &&
          reply.actor.provenance.connectionId === namedRecipient.connectionId &&
          reply.actor.provenance.catId === namedRecipient.agentId,
      )
    : false;
  const body = (
    <MessageBody
      event={root}
      participants={participants}
      responseState={replies.length ? 'responded' : 'waiting'}
      namedResponseState={namedRecipient ? (namedResponded ? 'responded' : 'waiting') : undefined}
    />
  );
  const interaction = (
    <MessageInteraction
      event={root}
      works={works}
      votes={votes}
      allWorks={allWorks}
      currentHumanId={currentHumanId}
      canSteward={canSteward}
      participants={participants}
      humanNames={humanNames}
      reactions={reactions}
      onReply={() => onOpenTopic(root.eventId, true)}
      onMention={() => onMention(root)}
      onProposeWork={onProposeWork ? () => onProposeWork(root) : undefined}
      onCommitWork={onCommitWork}
      onDeclineWork={onDeclineWork}
      onAcceptWorkResult={onAcceptWorkResult}
      onRequestWorkRevision={onRequestWorkRevision}
      onCompleteWork={onCompleteWork}
      onCreateVote={onCreateVote}
      onCastVote={onCastVote}
      onCloseVote={onCloseVote}
      roadmapActions={roadmapActions}
      onSetReaction={onSetReaction}
    />
  );
  const replyVitals =
    replies.length > 0 ? (
      <button type="button" className="reply-vitals" onClick={() => onOpenTopic(root.eventId)}>
        <span className="reply-summary">
          <strong>{replies.length} 条回复</strong>
          <small>最近 {formatEventTime(replies.at(-1)?.acceptedAt ?? root.acceptedAt)}</small>
        </span>
        <span className="reply-preview">
          {replies.slice(-2).map((reply) => (
            <span key={reply.eventId}>
              <b>{actorDisplayName(reply)}</b>
              <span>{reply.body}</span>
            </span>
          ))}
        </span>
      </button>
    ) : null;
  const frame = {
    id: `collective-event-${root.eventId}`,
    'data-event-id': root.eventId,
    'data-visual-weight': 'message',
    'data-highlighted': highlighted,
    tabIndex: -1,
  } as const;

  // F322 B segment 1 (human message): in the new presentation your own message is one block on the right with no
  // avatar and no signature, and another person is on the left with a nameplate. Cats and the classic layout are below.
  if (v2 && author === 'self') {
    return (
      <article {...frame} className="message message-self" data-author="self">
        <div className="message-content">
          <div className="message-bubble">{body}</div>
          {showTime && (
            <time className="message-time" dateTime={root.acceptedAt}>
              {formatEventTime(root.acceptedAt)}
            </time>
          )}
          {interaction}
          {replyVitals}
        </div>
      </article>
    );
  }
  if (v2 && author === 'other-human') {
    return (
      <article {...frame} className="message message-other" data-author="other-human">
        <div className="message-content">
          <header className="message-plate-row">
            <HumanNameplate event={root} participants={participants} onOpenMember={() => onOpenMember(root)} />
            <time dateTime={root.acceptedAt}>{formatEventTime(root.acceptedAt)}</time>
          </header>
          {body}
          {interaction}
          {replyVitals}
        </div>
      </article>
    );
  }
  return (
    <article {...frame} className="message">
      <button
        type="button"
        className="avatar-button"
        onClick={() => onOpenMember(root)}
        aria-label={`查看 ${actorDisplayName(root)}`}
      >
        <MessageAvatar event={root} participants={participants} />
      </button>
      <div className="message-content">
        <header className="message-meta">
          <strong>{actorDisplayName(root)}</strong>
          <span>{actorOrigin(root)}</span>
          <time dateTime={root.acceptedAt}>{formatEventTime(root.acceptedAt)}</time>
        </header>
        {body}
        {interaction}
        {replyVitals}
      </div>
    </article>
  );
}

interface ChannelMessageProps {
  readonly thread: ChannelThread;
  readonly onOpenTopic: (eventId: string, focusComposer?: boolean) => void;
  readonly onMention: (event: CollectiveEventEnvelope) => void;
  readonly onOpenMember: (event: CollectiveEventEnvelope) => void;
  readonly works?: readonly CollectiveWorkProjection[];
  readonly votes?: readonly CollectiveVoteProjection[];
  readonly allWorks?: readonly CollectiveWorkProjection[];
  readonly currentHumanId?: string;
  readonly canSteward?: boolean;
  readonly participants?: readonly CollectiveParticipant[];
  readonly humanNames?: Readonly<Record<string, string>>;
  readonly reactions?: readonly CollectiveReactionSummary[];
  readonly onProposeWork?: (event: CollectiveEventEnvelope) => void;
  readonly onCommitWork?: (work: CollectiveWorkProjection, participant?: CollectiveParticipant) => void;
  readonly onDeclineWork?: (work: CollectiveWorkProjection) => void;
  readonly onAcceptWorkResult?: (work: CollectiveWorkProjection) => void;
  readonly onRequestWorkRevision?: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly onCompleteWork?: (work: CollectiveWorkProjection) => void;
  readonly onCreateVote?: (sourceEventId: string, draft: InformalVoteDraft) => Promise<void>;
  readonly onCastVote?: (vote: CollectiveVoteProjection, optionId: string) => void;
  readonly onCloseVote?: (vote: CollectiveVoteProjection) => void;
  readonly roadmapActions?: (work: CollectiveWorkProjection) => readonly RoadmapAction[];
  readonly onSetReaction?: (eventId: string, emoji: CollectiveReactionEmoji, active: boolean) => void | Promise<void>;
  readonly highlighted?: boolean;
  /** Overrides the frame default (tests, previews). */
  readonly presentation?: 'v2' | 'classic';
  /** Self messages only: the time under the block, once per run of your own messages. */
  readonly showTime?: boolean;
}
