import type { EvolutionExplorationExperimentV1, EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import { ExplorationBehavior, measurementText } from './ExplorationBehavior';
import { ExplorationMedia } from './ExplorationMedia';
import type { explorationTraceBounds } from './ExplorationTrace';

export function ExplorationOutcome({
  programId,
  record,
  experiment,
  label,
  retry,
  bounds,
}: {
  programId: string;
  record: EvolutionExplorationRecordV1;
  experiment: EvolutionExplorationExperimentV1;
  label: string;
  retry(): void;
  bounds?: ReturnType<typeof explorationTraceBounds>;
}) {
  const visual = record.media.length > 0 || record.trace || record.mediaStatus;
  const readable = record.output.filter((entry) => {
    try {
      const value: unknown = JSON.parse(entry.value);
      return value === null || typeof value !== 'object';
    } catch {
      return true;
    }
  });
  return (
    <article className="exploration-outcome" data-result={record.result.status}>
      <header>
        <span>
          {label} · {experiment.title}
        </span>
        <strong>{record.result.label}</strong>
      </header>
      <dl className="exploration-outcome-metrics">
        {experiment.metrics.map((metric) => (
          <div key={metric.key}>
            <dt>{metric.label}</dt>
            <dd>
              {metric.unit === '0/1' && (record.values[metric.key] === 0 || record.values[metric.key] === 1)
                ? record.values[metric.key] === 1
                  ? '是'
                  : '否'
                : measurementText(record.values[metric.key], metric.unit)}
            </dd>
          </div>
        ))}
      </dl>
      {visual ? (
        <ExplorationMedia
          programId={programId}
          record={record}
          sideLabel={label}
          traceBounds={bounds}
          onRetry={retry}
        />
      ) : (
        <dl className="exploration-output-reading">
          {readable.slice(0, 2).map((entry, index) => (
            <div key={`${entry.label}:${index}`}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <details>
        <summary>输入、判据与原件</summary>
        <ExplorationBehavior record={record} experiment={experiment} />
      </details>
    </article>
  );
}
