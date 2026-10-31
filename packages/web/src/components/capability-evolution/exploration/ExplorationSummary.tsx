import type {
  EvolutionExplorationDetailV1,
  EvolutionExplorationExperimentV1,
  EvolutionExplorationNodeV1,
  EvolutionExplorationRecordV1,
} from '@cat-cafe/shared';
import { ExplorationDetailStatus } from './ExplorationDetailStatus';
import { ExplorationIcon } from './ExplorationIcon';
export function ExplorationSummary({
  node,
  experiments,
  experiment,
  records,
  detail,
  compareDetail,
  retry,
  onPreparation,
}: {
  node: EvolutionExplorationNodeV1;
  experiments: EvolutionExplorationExperimentV1[];
  experiment?: EvolutionExplorationExperimentV1;
  records: EvolutionExplorationRecordV1[];
  detail?: EvolutionExplorationDetailV1;
  compareDetail?: EvolutionExplorationDetailV1;
  retry(): void;
  onPreparation?: () => void;
}) {
  return (
    <section className="exploration-summary" aria-label="探索进化摘要">
      <h2>
        <ExplorationIcon kind="branch" />
        探索进化
      </h2>
      <p>
        正在阅读 <strong>{node.title}</strong> · {experiments.length ? `${experiments.length} 轮实验` : '尚未测量'}
      </p>
      <p>{node.kind === 'public_archive' ? '公开归档，尚未纳入本项目的正式版本。' : node.summary}</p>
      <ExplorationDetailStatus detail={detail} retry={retry} />
      <ExplorationDetailStatus detail={compareDetail} label="对照" retry={retry} />
      {experiment && (
        <p>
          {experiment.conditions.window.label} · {experiment.conditions.sampleSet.label}
        </p>
      )}
      {records.some((record) => record.result.status === 'violated') && (
        <p className="exploration-summary-warning">
          <ExplorationIcon kind="warning" />
          本轮有失败或反例，展开查看结果与原件。
        </p>
      )}
      {onPreparation && (
        <button type="button" className="exploration-link" onClick={onPreparation}>
          回读准备材料
        </button>
      )}
    </section>
  );
}
