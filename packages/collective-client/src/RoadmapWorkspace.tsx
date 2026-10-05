import { useState } from 'react';
import { BindingVoteSection } from './BindingVoteCard.js';
import type {
  CollectiveBindingVoteChoice,
  CollectiveBindingVoteProjection,
  CollectiveDecisionRecord,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import { RoadmapPanel } from './RoadmapPanel.js';
import { defaultRoadmapView, type RoadmapViewState } from './roadmap-view-model.js';
import type { VoteDraft } from './VoteDraftForm.js';

export function RoadmapWorkspace({
  roadmaps,
  works,
  currentHumanId,
  humanNames = {},
  view,
  onViewChange,
  onOpenSource,
  onOpenResult,
  onSetDependencies,
  onSetStatus,
  bindingVotes,
  decisions,
  onCreateBindingVote,
  onCastBindingVote,
  onWithdrawBindingVote,
  onSettleBindingVote,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly humanNames?: Readonly<Record<string, string>>;
  readonly view?: RoadmapViewState;
  readonly onViewChange?: (view: RoadmapViewState) => void;
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenResult?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onSetDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) => void;
  readonly onSetStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') => void;
  readonly bindingVotes: readonly CollectiveBindingVoteProjection[];
  readonly decisions: readonly CollectiveDecisionRecord[];
  readonly onCreateBindingVote: (roadmap: CollectiveRoadmapRecord, draft: VoteDraft) => Promise<void>;
  readonly onCastBindingVote: (vote: CollectiveBindingVoteProjection, choice: CollectiveBindingVoteChoice) => void;
  readonly onWithdrawBindingVote: (vote: CollectiveBindingVoteProjection) => void;
  readonly onSettleBindingVote: (vote: CollectiveBindingVoteProjection) => void;
}) {
  const [internalView, setInternalView] = useState<RoadmapViewState>(() => ({
    ...defaultRoadmapView,
    roadmapId: roadmaps[0]?.roadmapId,
  }));
  const activeView = view ?? internalView;
  const selected = roadmaps.find((roadmap) => roadmap.roadmapId === activeView.roadmapId) ?? roadmaps[0];
  if (!selected) return null;
  const updateView = (next: RoadmapViewState) => {
    if (!view) setInternalView(next);
    onViewChange?.(next);
  };
  return (
    <div className="roadmap-workspace">
      {roadmaps.length > 1 && (
        <nav className="roadmap-switcher" aria-label="Roadmap 列表">
          {roadmaps.map((roadmap) => (
            <button
              key={roadmap.roadmapId}
              type="button"
              aria-current={roadmap.roadmapId === selected.roadmapId ? 'page' : undefined}
              onClick={() =>
                updateView({
                  ...defaultRoadmapView,
                  roadmapId: roadmap.roadmapId,
                })
              }
            >
              <span>{roadmap.title}</span>
              <small>{roadmap.status === 'active' ? '进行中' : '已完成'}</small>
            </button>
          ))}
        </nav>
      )}
      <RoadmapPanel
        roadmap={selected}
        works={works}
        currentHumanId={currentHumanId}
        humanNames={humanNames}
        view={{ ...activeView, roadmapId: selected.roadmapId }}
        onViewChange={updateView}
        onOpenSource={onOpenSource}
        onOpenResult={onOpenResult}
        onSetDependencies={onSetDependencies}
        onSetStatus={onSetStatus}
      />
      <BindingVoteSection
        roadmap={selected}
        votes={bindingVotes}
        decisions={decisions}
        currentHumanId={currentHumanId}
        onCreate={onCreateBindingVote}
        onCast={onCastBindingVote}
        onWithdraw={onWithdrawBindingVote}
        onSettle={onSettleBindingVote}
      />
    </div>
  );
}
