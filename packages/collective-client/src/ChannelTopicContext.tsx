import { roadmapActionsFor } from './channel-collaboration.js';
import type { ChannelSceneProps } from './channel-scene-props.js';
import type {
  ChannelThread,
  CollectiveReactionSummary,
  CollectiveRoadmapRecord,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
} from './client-types.js';
import { TopicPanel } from './TopicPanel.js';

/** The original Topic stays mounted beside a shared work; it retains the existing composer and Work decisions. */
export function ChannelTopicContext({
  scene,
  topic,
  replyRequest,
  works,
  votes,
  humanNames,
  roadmaps,
  reactions,
  highlightedId,
  onClose,
  onReturnToSource,
}: {
  readonly scene: ChannelSceneProps;
  readonly topic: ChannelThread;
  readonly replyRequest?: { eventId: string };
  readonly works: readonly CollectiveWorkProjection[];
  readonly votes: readonly CollectiveVoteProjection[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly reactions: readonly CollectiveReactionSummary[];
  readonly highlightedId?: string;
  readonly onClose: () => void;
  readonly onReturnToSource: () => void;
}) {
  return (
    <TopicPanel
      namespace={scene.namespace}
      thread={topic}
      replyRequest={replyRequest}
      humans={scene.members?.humans ?? []}
      participants={scene.participants ?? []}
      delivery={scene.delivery}
      works={works}
      votes={votes}
      allWorks={works}
      currentHumanId={scene.humanId}
      humanNames={humanNames}
      canSteward={scene.collective.role === 'steward'}
      onOpenMember={scene.onOpenMember}
      onClose={onClose}
      onReturnToSource={onReturnToSource}
      onSend={scene.onSend}
      onProposeWork={(id) => void scene.onProposeWork(id).catch(() => undefined)}
      onCommitWork={(work, participant, accountability) =>
        void scene.onCommitWork(work, participant, accountability).catch(() => undefined)
      }
      onDeclineWork={(work) => void scene.onDeclineWork(work).catch(() => undefined)}
      onAcceptWorkResult={(work) => void scene.onAcceptWorkResult(work).catch(() => undefined)}
      onRequestWorkRevision={scene.onRequestWorkRevision}
      onCompleteWork={(work) => void scene.onCompleteWork(work).catch(() => undefined)}
      onCreateVote={scene.onCreateVote}
      onCastVote={(vote, optionId) => void scene.onCastVote(vote, optionId).catch(() => undefined)}
      onCloseVote={(vote) => void scene.onCloseVote(vote).catch(() => undefined)}
      roadmapActions={(work) =>
        roadmapActionsFor(work, roadmaps, scene.humanId, scene.onCreateRoadmap, scene.onSetRoadmapWorks)
      }
      reactions={reactions}
      onSetReaction={scene.onSetReaction}
      highlightedId={highlightedId}
    />
  );
}
