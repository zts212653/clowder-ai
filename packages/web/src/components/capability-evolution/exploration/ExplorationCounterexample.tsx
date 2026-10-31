import { type EvolutionExplorationRecordV1, refIdentity } from '@cat-cafe/shared';
import { ExplorationOutcome } from './ExplorationOutcome';
import { ExplorationPairEvidence } from './ExplorationPairEvidence';
import type { ExplorationComparison, ExplorationComparisonSide } from './exploration-comparison';

/** A filter never hides an owner-declared violated result. Unknown results remain unknown. */
export function ExplorationCounterexample({
  programId,
  right,
  left,
  comparison,
  selectedRecord,
  retry,
}: {
  programId: string;
  right: ExplorationComparisonSide;
  left?: ExplorationComparisonSide;
  comparison?: ExplorationComparison;
  selectedRecord?: EvolutionExplorationRecordV1;
  retry(): void;
}) {
  const record = right.records.find((item) => item.result.status === 'violated');
  if (!record || (selectedRecord && refIdentity(record.recordRef) === refIdentity(selectedRecord.recordRef)))
    return null;
  const pair =
    comparison?.status === 'paired'
      ? comparison.pairs.find((item) => refIdentity(item.right.recordRef) === refIdentity(record.recordRef))
      : undefined;
  return (
    <section className="exploration-counterexample" aria-label="本次判据未通过的记录">
      <h3>本次判据未通过的记录 · {record.label}</h3>
      <p>按这次实验的判法呈现，不把未裁定记录算成失败，不外推至其它条件。</p>
      {pair && left ? (
        <ExplorationPairEvidence
          key={`${refIdentity(pair.left.recordRef)}:${refIdentity(pair.right.recordRef)}`}
          programId={programId}
          left={pair.left}
          right={pair.right}
          leftExperiment={left.experiment}
          rightExperiment={right.experiment}
          linked
          retry={retry}
        />
      ) : (
        <ExplorationOutcome
          key={refIdentity(record.recordRef)}
          programId={programId}
          record={record}
          experiment={right.experiment}
          label="本次"
          retry={retry}
        />
      )}
    </section>
  );
}
