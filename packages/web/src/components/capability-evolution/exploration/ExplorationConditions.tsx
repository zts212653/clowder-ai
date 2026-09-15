import type { EvolutionExplorationExperimentV1 } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { ExplorationIcon } from './ExplorationIcon';

export function ExplorationConditions({
  experiment,
  onPreparation,
}: {
  experiment: EvolutionExplorationExperimentV1;
  onPreparation?: () => void;
}) {
  const { conditions } = experiment;
  return (
    <section className="exploration-conditions" aria-label="本次条件与判断边界">
      <dl className="exploration-condition-summary" aria-label="当前实验条件">
        <div data-exploration-category="measurement">
          <dt>
            <ExplorationIcon kind="environment" />
            环境
          </dt>
          <dd>{conditions.environment.label}</dd>
        </div>
        <div data-exploration-category="measurement">
          <dt>
            <ExplorationIcon kind="samples" />
            样本与重复
          </dt>
          <dd>{conditions.sampleSet.label}</dd>
        </div>
        <div data-exploration-category="rubric">
          <dt>
            <ExplorationIcon kind="measurement" />
            量尺与观察窗
          </dt>
          <dd>
            {conditions.measurement.label}
            <span>{conditions.window.label}</span>
          </dd>
        </div>
        <div data-exploration-category="rubric">
          <dt>
            <ExplorationIcon kind="contract" />
            GT 与判据
          </dt>
          <dd>
            {conditions.groundTruth.label}
            <span>{conditions.threshold.status === 'frozen' ? '本次判据已冻结' : '效用门槛未冻结'}</span>
          </dd>
        </div>
      </dl>
      <details className="exploration-condition-details">
        <summary>展开环境、量尺与 GT 来源</summary>
        <dl className="exploration-condition-grid">
          {(['environment', 'sampleSet', 'measurement', 'groundTruth', 'window'] as const).map((key) => (
            <div key={key}>
              <dt>
                {
                  {
                    environment: '环境',
                    sampleSet: '样本与重复',
                    measurement: '量尺',
                    groundTruth: 'GT 来源',
                    window: '观察窗口',
                  }[key]
                }
              </dt>
              <dd>
                <strong>{conditions[key].label}</strong>
                <p>{conditions[key].detail}</p>
                <EvolutionSource label="来源" source={conditions[key].sourceRef} />
              </dd>
            </div>
          ))}
          <div>
            <dt>效用门槛</dt>
            <dd>
              <strong>{conditions.threshold.status === 'frozen' ? '已冻结' : '尚未冻结，结论未知'}</strong>
              <p>{conditions.threshold.detail}</p>
            </dd>
          </div>
        </dl>
        <p>{conditions.limitation}</p>
        {onPreparation && (
          <button type="button" className="exploration-link" onClick={onPreparation}>
            回读准备材料
          </button>
        )}
      </details>
    </section>
  );
}
