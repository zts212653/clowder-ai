import type { EvolutionExplorationExperimentV1, EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import { ExplorationOutcome } from './ExplorationOutcome';
import { ExplorationPlaybackGroup } from './ExplorationPlaybackGroup';
import { explorationTraceBounds } from './ExplorationTrace';

/** Both the selected case and its counterexample use the same exact evidence reader. */
export function ExplorationPairEvidence({
  programId,
  left,
  right,
  leftExperiment,
  rightExperiment,
  linked = false,
  retry,
}: {
  programId: string;
  left: EvolutionExplorationRecordV1;
  right: EvolutionExplorationRecordV1;
  leftExperiment: EvolutionExplorationExperimentV1;
  rightExperiment: EvolutionExplorationExperimentV1;
  linked?: boolean;
  retry(): void;
}) {
  const bounds = left.trace && right.trace ? explorationTraceBounds([left.trace, right.trace]) : undefined;
  return (
    <ExplorationPlaybackGroup enabled={linked}>
      <ExplorationOutcome
        programId={programId}
        record={left}
        experiment={leftExperiment}
        label="对照"
        retry={retry}
        bounds={bounds}
      />
      <ExplorationOutcome
        programId={programId}
        record={right}
        experiment={rightExperiment}
        label="本版"
        retry={retry}
        bounds={bounds}
      />
    </ExplorationPlaybackGroup>
  );
}
