import {
  type EvolutionExplorationExperimentV1,
  type EvolutionExplorationRecordV1,
  refIdentity,
} from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { ExplorationIcon } from './ExplorationIcon';

export function measurementText(value: number | null | undefined, unit: string): string {
  return value == null ? '未观测到' : `${Number.isInteger(value) ? value : Number(value.toFixed(3))} ${unit}`;
}

/** A data view of actual inputs and outputs. The glyph explains the trace; it is not efficacy evidence. */
export function ExplorationBehavior({
  record,
  experiment,
}: {
  record: EvolutionExplorationRecordV1;
  experiment: EvolutionExplorationExperimentV1;
}) {
  return (
    <section
      className="exploration-behavior"
      aria-label="本次实际输入输出"
      data-record-ref={refIdentity(record.recordRef)}
    >
      <div className="exploration-behavior-heading">
        <ExplorationIcon kind="code" />
        <h4>本次实际输入与结果</h4>
        <span className="exploration-caption">由运行数据呈现</span>
      </div>
      <div className="exploration-io">
        <div>
          <h5>输入</h5>
          <dl>
            {record.input.map((entry, index) => (
              <div key={`${entry.label}:${index}`}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <span className="exploration-io-arrow" aria-hidden="true">
          →
        </span>
        <div>
          <h5>输出</h5>
          <dl>
            {record.output.map((entry, index) => (
              <div key={`${entry.label}:${index}`}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="exploration-measurements">
        {experiment.metrics.map((metric) => (
          <details key={metric.key}>
            <summary>
              <span>{metric.label}</span>
              <strong>{measurementText(record.values[metric.key], metric.unit)}</strong>
            </summary>
            <p>{metric.definition}</p>
            <EvolutionSource label="测量定义" source={metric.sourceRef} />
          </details>
        ))}
      </div>
      <details className="exploration-sources">
        <summary>判据与原始来源</summary>
        <p>
          {experiment.conditions.measurement.label} · {record.result.label}
        </p>
        <p>{experiment.conditions.threshold.detail}</p>
        {record.sources.map((source) => (
          <EvolutionSource key={refIdentity(source.ref)} label={source.label} source={source.ref} href={source.href} />
        ))}
      </details>
    </section>
  );
}
