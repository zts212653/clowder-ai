import { useRef, useState } from 'react';
import { CollectiveWorkCard } from './CollectiveWorkCard.js';
import type { RoadmapAction } from './channel-collaboration.js';
import { actorDisplayName } from './channel-model.js';
import type {
  CollectiveEventEnvelope,
  CollectiveParticipant,
  CollectiveReactionEmoji,
  CollectiveReactionSummary,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
} from './client-types.js';
import { MessageActionBar } from './MessageActionBar.js';
import { ReactionBar, reactionsForEvent } from './ReactionBar.js';
import { InformalVoteCard, InformalVoteComposer, type InformalVoteDraft } from './VoteCard.js';

function eventOwnerHumanId(event: CollectiveEventEnvelope): string {
  return event.actor.kind === 'human' ? event.actor.humanId : event.actor.human.humanId;
}

export function MessageInteraction({
  event,
  works = [],
  votes = [],
  allWorks = [],
  currentHumanId,
  canSteward = false,
  participants = [],
  humanNames = {},
  reactions = [],
  onReply,
  onMention,
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
}: MessageInteractionProps) {
  const [pendingReaction, setPendingReaction] = useState<CollectiveReactionEmoji>();
  const [reactionError, setReactionError] = useState<string>();
  const [voteDraftOpen, setVoteDraftOpen] = useState(false);
  const pendingRef = useRef(false);
  const reactionTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const eventReactions = reactionsForEvent(event.eventId, reactions);
  const activeReactions = new Set(
    currentHumanId
      ? eventReactions.filter((reaction) => reaction.humanIds.includes(currentHumanId)).map((item) => item.emoji)
      : [],
  );
  const requestReaction = (
    emoji: CollectiveReactionEmoji,
    active: boolean,
    returnFocus: HTMLElement | null = moreTriggerRef.current,
  ) => {
    if (!onSetReaction || pendingRef.current) return;
    pendingRef.current = true;
    setPendingReaction(emoji);
    setReactionError(undefined);
    returnFocus?.focus();
    void Promise.resolve()
      .then(() => onSetReaction(event.eventId, emoji, active))
      .catch(() => setReactionError('回应未保存，请重试。'))
      .finally(() => {
        pendingRef.current = false;
        setPendingReaction(undefined);
      });
  };

  return (
    <div className="message-interaction" data-message-interaction-event-id={event.eventId}>
      {currentHumanId && onSetReaction && (
        <ReactionBar
          eventId={event.eventId}
          reactions={reactions}
          currentHumanId={currentHumanId}
          humanNames={humanNames}
          pending={pendingReaction}
          error={reactionError}
          onSetReaction={requestReaction}
        />
      )}
      {currentHumanId &&
        onCommitWork &&
        onDeclineWork &&
        onAcceptWorkResult &&
        onCompleteWork &&
        works.map((work) => (
          <CollectiveWorkCard
            key={work.workId}
            work={work}
            works={allWorks}
            currentHumanId={currentHumanId}
            sourceOwnerHumanId={eventOwnerHumanId(event)}
            canSteward={canSteward}
            participants={participants}
            humanNames={humanNames}
            onCommit={onCommitWork}
            onDecline={onDeclineWork}
            onAcceptResult={onAcceptWorkResult}
            onRequestRevision={onRequestWorkRevision}
            onComplete={onCompleteWork}
            roadmapActions={roadmapActions?.(work)}
          />
        ))}
      {currentHumanId &&
        onCastVote &&
        onCloseVote &&
        votes.map((vote) => (
          <InformalVoteCard
            key={vote.voteId}
            vote={vote}
            currentHumanId={currentHumanId}
            canSteward={canSteward}
            onCast={onCastVote}
            onClose={onCloseVote}
          />
        ))}
      {voteDraftOpen && onCreateVote && (
        <InformalVoteComposer
          sourceEventId={event.eventId}
          sourceBody={event.body}
          onCreate={onCreateVote}
          onCancel={() => setVoteDraftOpen(false)}
        />
      )}
      <MessageActionBar
        eventLabel={actorDisplayName(event)}
        activeReactions={activeReactions}
        pendingReaction={pendingReaction}
        reactionTriggerRef={reactionTriggerRef}
        moreTriggerRef={moreTriggerRef}
        onSetReaction={currentHumanId && onSetReaction ? requestReaction : undefined}
        onReply={onReply}
        onMention={onMention}
        onStartVote={onCreateVote && votes.length === 0 ? () => setVoteDraftOpen(true) : undefined}
        onProposeWork={onProposeWork && works.length === 0 ? onProposeWork : undefined}
      />
    </div>
  );
}

export interface MessageInteractionProps {
  readonly event: CollectiveEventEnvelope;
  readonly works?: readonly CollectiveWorkProjection[];
  readonly votes?: readonly CollectiveVoteProjection[];
  readonly allWorks?: readonly CollectiveWorkProjection[];
  readonly currentHumanId?: string;
  readonly canSteward?: boolean;
  readonly participants?: readonly CollectiveParticipant[];
  readonly humanNames?: Readonly<Record<string, string>>;
  readonly reactions?: readonly CollectiveReactionSummary[];
  readonly onReply?: () => void;
  readonly onMention?: () => void;
  readonly onProposeWork?: () => void;
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
}
