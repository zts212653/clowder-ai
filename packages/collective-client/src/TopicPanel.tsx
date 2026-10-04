import { useEffect, useId, useRef, useState } from 'react';
import { Composer, type HumanMention } from './Composer.js';
import type { RoadmapAction } from './channel-collaboration.js';
import { actorDisplayName } from './channel-model.js';
import type {
  ChannelThread,
  ClientTarget,
  CollectiveEventEnvelope,
  CollectiveParticipant,
  CollectiveReactionEmoji,
  CollectiveReactionSummary,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
  DeliveryState,
} from './client-types.js';
import type { ReplySelection } from './composer-draft.js';
import { MessageInteraction } from './MessageInteraction.js';
import { isLastOfSelfRunInTopic } from './message-presentation.js';
import { replySelectionForEvent } from './participant-identity.js';
import { TopicMessage } from './TopicMessage.js';
import type { InformalVoteDraft } from './VoteCard.js';

export function TopicPanel({
  thread,
  replyRequest,
  namespace,
  delivery,
  onClose,
  onReturnToSource,
  onOpenMember,
  onSend,
  participants,
  humans,
  works,
  votes = [],
  allWorks,
  currentHumanId,
  humanNames,
  canSteward,
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
  reactions = [],
  onSetReaction,
  highlightedId,
}: TopicPanelProps) {
  const composerInputId = useId();
  const [reply, setReply] = useState<ReplySelection>();
  const consumedReplyRequest = useRef<typeof replyRequest>();
  const location =
    thread.root.location ??
    (thread.root.target.kind === 'channel' ? { channelId: thread.root.target.channelId } : undefined);
  const topicEvents = [thread.root, ...thread.replies];
  const selectReply = (event: CollectiveEventEnvelope): ReplySelection => ({
    eventId: event.eventId,
    ...replySelectionForEvent(event, participants, location?.channelId ?? '', currentHumanId),
  });
  useEffect(() => {
    if (!replyRequest || consumedReplyRequest.current === replyRequest) return;
    consumedReplyRequest.current = replyRequest;
    const event = [thread.root, ...thread.replies].find((item) => item.eventId === replyRequest.eventId);
    setReply({
      eventId: replyRequest.eventId,
      ...(event
        ? replySelectionForEvent(event, participants, location?.channelId ?? '', currentHumanId)
        : { error: '正在回复的消息当前不可用。' }),
    });
  }, [replyRequest, thread, participants, location?.channelId, currentHumanId]);
  const eventWithInteractions = (event: CollectiveEventEnvelope, index: number) => {
    const linkedWorks = works.filter((work) => work.sourceEventId === event.eventId);
    const linkedVotes = votes.filter((vote) => vote.sourceEventId === event.eventId);
    return (
      <div
        key={event.eventId}
        id={`collective-event-${event.eventId}`}
        className="topic-event"
        data-event-id={event.eventId}
        data-highlighted={highlightedId === event.eventId}
        tabIndex={-1}
      >
        <TopicMessage
          event={event}
          participants={participants}
          onOpenMember={onOpenMember}
          currentHumanId={currentHumanId}
          showTime={isLastOfSelfRunInTopic(topicEvents, index, currentHumanId)}
        />
        <MessageInteraction
          event={event}
          works={linkedWorks}
          votes={linkedVotes}
          allWorks={allWorks}
          currentHumanId={currentHumanId}
          canSteward={canSteward}
          participants={participants}
          humanNames={humanNames}
          reactions={reactions}
          onReply={() => setReply(selectReply(event))}
          onProposeWork={() => onProposeWork(event.eventId)}
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
      </div>
    );
  };
  return (
    <aside className="context-panel" data-spatial-role="context-panel" aria-label="话题">
      <header className="context-header">
        <div>
          <span>话题 · {location ? `# ${location.channelId}` : '早期记录'}</span>
          <h2>{thread.replies.length} 条回复</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭话题">
          ×
        </button>
      </header>
      <button type="button" className="topic-return" onClick={onReturnToSource}>
        在频道中查看
      </button>
      <div className="topic-flow">
        {eventWithInteractions(thread.root, 0)}
        <div className="topic-divider">
          <span>回应</span>
        </div>
        {thread.replies.map((reply, index) => eventWithInteractions(reply, index + 1))}
      </div>
      {location ? (
        <Composer
          compact
          inputId={composerInputId}
          namespace={namespace}
          channelId={location.channelId}
          rootEventId={thread.root.eventId}
          participants={participants}
          humans={humans}
          reply={reply}
          replyEvents={topicEvents}
          placeholder={`回复 ${actorDisplayName(thread.root)}`}
          delivery={delivery}
          onSend={(body, recipient, entrust, responseRequested, replyToEventId) =>
            onSend(body, {
              location: { ...location, rootEventId: location.rootEventId ?? thread.root.eventId },
              recipient,
              replyToEventId: replyToEventId ?? thread.root.eventId,
              ...(responseRequested && recipient.kind === 'channel'
                ? { attentionRequest: 'response_requested' as const }
                : {}),
              ...(entrust && recipient.kind === 'agent' ? { workRequest: 'entrust' } : {}),
            })
          }
        />
      ) : (
        <p>这条早期记录的位置尚未确认，暂时无法回复。</p>
      )}
    </aside>
  );
}

interface TopicPanelProps {
  readonly thread: ChannelThread;
  readonly replyRequest?: { readonly eventId: string };
  readonly namespace: string;
  readonly delivery: DeliveryState;
  readonly onClose: () => void;
  readonly onReturnToSource: () => void;
  readonly onOpenMember: (event: CollectiveEventEnvelope) => void;
  readonly onSend: (body: string, target: ClientTarget) => Promise<void>;
  readonly participants: readonly CollectiveParticipant[];
  readonly humans: readonly HumanMention[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly votes?: readonly CollectiveVoteProjection[];
  readonly allWorks: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly humanNames: Readonly<Record<string, string>>;
  readonly canSteward: boolean;
  readonly onProposeWork: (sourceEventId: string) => void;
  readonly onCommitWork: (work: CollectiveWorkProjection, participant?: CollectiveParticipant) => void;
  readonly onDeclineWork: (work: CollectiveWorkProjection) => void;
  readonly onAcceptWorkResult: (work: CollectiveWorkProjection) => void;
  readonly onRequestWorkRevision?: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly onCompleteWork: (work: CollectiveWorkProjection) => void;
  readonly onCreateVote?: (sourceEventId: string, draft: InformalVoteDraft) => Promise<void>;
  readonly onCastVote?: (vote: CollectiveVoteProjection, optionId: string) => void;
  readonly onCloseVote?: (vote: CollectiveVoteProjection) => void;
  readonly roadmapActions?: (work: CollectiveWorkProjection) => readonly RoadmapAction[];
  readonly reactions?: readonly CollectiveReactionSummary[];
  readonly onSetReaction?: (eventId: string, emoji: CollectiveReactionEmoji, active: boolean) => void | Promise<void>;
  readonly highlightedId?: string;
}
