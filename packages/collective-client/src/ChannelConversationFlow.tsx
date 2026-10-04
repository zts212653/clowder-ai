import type { ReactNode, RefObject } from 'react';
import { ChannelMessage } from './ChannelMessage.js';
import { roadmapActionsFor } from './channel-collaboration.js';
import { eventChannelId, eventDayLabel } from './channel-navigation.js';
import type {
  ChannelThread,
  CollectiveEventEnvelope,
  CollectiveParticipant,
  CollectiveReactionSummary,
  CollectiveRoadmapRecord,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
} from './client-types.js';
import { isLastOfSelfRun, isLastOfSelfRunInTopic } from './message-presentation.js';
import { TopicMessage } from './TopicMessage.js';
import type { InformalVoteDraft } from './VoteCard.js';

export function ChannelConversationFlow({
  flowRef,
  threads,
  legacy,
  search,
  humanName,
  channelWorks,
  channelVotes,
  channelReactions,
  highlightedId,
  humanId,
  canSteward,
  participants,
  humanNames,
  roadmaps,
  actions,
  presentation,
  children,
}: {
  readonly flowRef: RefObject<HTMLDivElement>;
  readonly threads: readonly ChannelThread[];
  readonly legacy: readonly CollectiveEventEnvelope[];
  readonly search: boolean;
  readonly humanName: string;
  readonly channelWorks: readonly CollectiveWorkProjection[];
  readonly channelVotes: readonly CollectiveVoteProjection[];
  readonly channelReactions: readonly CollectiveReactionSummary[];
  readonly highlightedId?: string;
  readonly humanId: string;
  readonly canSteward: boolean;
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly actions: ChannelConversationActions;
  /** Overrides the frame default (tests, previews). */
  readonly presentation?: 'v2' | 'classic';
  readonly children?: ReactNode;
}) {
  return (
    <div ref={flowRef} className="channel-flow" aria-live="polite">
      {threads.length === 0 && !children ? (
        <div className="channel-empty">
          <h2>{search ? '没有找到相关讨论' : '这里还很安静'}</h2>
          <p>{search ? '换一个关键词，或者从左边进入频道。' : `${humanName}，从一句话开始吧。`}</p>
        </div>
      ) : (
        threads.map((thread, index) => (
          <div key={thread.root.eventId}>
            {(!index ||
              eventDayLabel(threads[index - 1]?.root.acceptedAt) !== eventDayLabel(thread.root.acceptedAt)) && (
              <div className="day-divider">
                <span>{eventDayLabel(thread.root.acceptedAt)}</span>
              </div>
            )}
            {search && (
              <button type="button" className="search-source" onClick={() => actions.returnToRoot(thread.root)}>
                # {eventChannelId(thread.root)} · 在频道中查看
              </button>
            )}
            <ChannelMessage
              thread={thread}
              onOpenTopic={actions.openTopic}
              onMention={actions.mention}
              onOpenMember={actions.openMember}
              highlighted={highlightedId === thread.root.eventId}
              presentation={presentation}
              showTime={isLastOfSelfRun(threads, index, humanId)}
              works={channelWorks.filter((work) => work.sourceEventId === thread.root.eventId)}
              votes={channelVotes.filter((vote) => vote.sourceEventId === thread.root.eventId)}
              allWorks={channelWorks}
              currentHumanId={humanId}
              canSteward={canSteward}
              participants={participants}
              humanNames={humanNames}
              reactions={channelReactions}
              onProposeWork={(event) => void actions.proposeWork(event.eventId).catch(() => undefined)}
              onCommitWork={(work, participant) => void actions.commitWork(work, participant).catch(() => undefined)}
              onDeclineWork={(work) => void actions.declineWork(work).catch(() => undefined)}
              onAcceptWorkResult={(work) => void actions.acceptWorkResult(work).catch(() => undefined)}
              onRequestWorkRevision={actions.requestWorkRevision}
              onCompleteWork={(work) => void actions.completeWork(work).catch(() => undefined)}
              onCreateVote={actions.createVote}
              onCastVote={(vote, optionId) => void actions.castVote(vote, optionId).catch(() => undefined)}
              onCloseVote={(vote) => void actions.closeVote(vote).catch(() => undefined)}
              roadmapActions={(work) =>
                roadmapActionsFor(work, roadmaps, humanId, actions.createRoadmap, actions.setRoadmapWorks)
              }
              onSetReaction={actions.setReaction}
            />
          </div>
        ))
      )}
      {children}
      {legacy.length > 0 && !search && (
        <details className="legacy-history">
          <summary>早期记录 · 位置尚未确认</summary>
          {legacy.map((event, index) => (
            <TopicMessage
              key={event.eventId}
              event={event}
              participants={participants}
              onOpenMember={actions.openMember}
              currentHumanId={humanId}
              presentation={presentation}
              showTime={isLastOfSelfRunInTopic(legacy, index, humanId)}
            />
          ))}
        </details>
      )}
    </div>
  );
}

export interface ChannelConversationActions {
  readonly returnToRoot: (event: CollectiveEventEnvelope) => void;
  readonly openTopic: (eventId: string, focusComposer?: boolean) => void;
  readonly mention: (event: CollectiveEventEnvelope) => void;
  readonly openMember: (event: CollectiveEventEnvelope) => void;
  readonly proposeWork: (sourceEventId: string) => Promise<void>;
  readonly commitWork: (work: CollectiveWorkProjection, participant?: CollectiveParticipant) => Promise<void>;
  readonly declineWork: (work: CollectiveWorkProjection) => Promise<void>;
  readonly acceptWorkResult: (work: CollectiveWorkProjection) => Promise<void>;
  readonly requestWorkRevision: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly completeWork: (work: CollectiveWorkProjection) => Promise<void>;
  readonly createVote: (sourceEventId: string, draft: InformalVoteDraft) => Promise<void>;
  readonly castVote: (vote: CollectiveVoteProjection, optionId: string) => Promise<void>;
  readonly closeVote: (vote: CollectiveVoteProjection) => Promise<void>;
  readonly createRoadmap: (work: CollectiveWorkProjection) => Promise<void>;
  readonly setRoadmapWorks: (roadmap: CollectiveRoadmapRecord, workIds: readonly string[]) => Promise<void>;
  readonly setReaction: (
    eventId: string,
    emoji: import('./client-types.js').CollectiveReactionEmoji,
    active: boolean,
  ) => Promise<void>;
}
