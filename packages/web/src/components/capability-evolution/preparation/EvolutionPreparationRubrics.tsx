import type { EvolutionPreparationBodyV1 } from '@cat-cafe/shared';
import { PreparationDetails } from './PreparationDetails';

type Criterion = Extract<EvolutionPreparationBodyV1, { kind: 'success_contract' }>['criteria'][number];

const DOMAIN = {
  verifiable: '可验证',
  semi_verifiable: '需校准判断',
  open_value: '开放价值',
} as const;
const JUDGE = {
  verifier: '可重复核验',
  calibrated_judge: '校准裁判',
  value_owner: '价值 owner',
  mixed: '混合裁判',
} as const;
const PAYER = {
  engineering_maintenance: '工程维护',
  judge_runway: '裁判运行',
  human_attention: '人的注意力',
  mixed: '混合成本',
} as const;

export function EvolutionPreparationRubrics({
  programId,
  revision,
  criteria,
  gtLabels,
  onJumpGtSource,
}: {
  programId: string;
  revision: string;
  criteria: Criterion[];
  gtLabels: Readonly<Record<string, string>>;
  onJumpGtSource: (sourceKey: string, criterionId: string) => void;
}) {
  return (
    <div className="evolution-preparation-rubrics">
      {criteria.map((criterion) => (
        <PreparationDetails
          programId={programId}
          readingKey={`${revision}:criterion:${criterion.criterionId}`}
          data-preparation-revision={revision}
          key={criterion.criterionId}
          className="evolution-preparation-rubric"
          data-preparation-criterion={criterion.criterionId}
        >
          <summary tabIndex={-1}>
            <span>{criterion.label}</span>
            <span className="evolution-preparation-domain">{DOMAIN[criterion.gtDomain]}</span>
          </summary>
          <div className="evolution-preparation-rubric-body">
            <p>{criterion.utilityClaim}</p>
            {criterion.gtDomain === 'semi_verifiable' && (
              <p>机器判断需先校准，并保留适当人审；具体取证渠道由本条规约决定。</p>
            )}
            <dl className="evolution-preparation-facts">
              <div>
                <dt>观察单位</dt>
                <dd>{criterion.observationUnit}</dd>
              </div>
              <div>
                <dt>具体判法</dt>
                <dd>{criterion.estimator}</dd>
              </div>
              <div>
                <dt>反例</dt>
                <dd>{criterion.counterexample}</dd>
              </div>
              <div>
                <dt>GT 域</dt>
                <dd>{DOMAIN[criterion.gtDomain]}</dd>
              </div>
              <div>
                <dt>裁判</dt>
                <dd>{JUDGE[criterion.judge]}</dd>
              </div>
              <div>
                <dt>付薪方</dt>
                <dd>
                  {PAYER[criterion.payer.kind]} · {criterion.payer.detail}
                </dd>
              </div>
            </dl>
            <div className="evolution-preparation-bounds">
              <strong>适用边界</strong>
              <ul>
                {criterion.validityBounds.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </div>
            {criterion.unknowns.length > 0 && (
              <div className="evolution-preparation-unknowns">
                <strong>仍未知</strong>
                <ul>
                  {criterion.unknowns.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="evolution-preparation-gt-links">
              {criterion.gtSourceKeys.map((sourceKey) => (
                <button
                  key={sourceKey}
                  type="button"
                  className="evolution-link"
                  data-gt-source-jump={sourceKey}
                  onClick={() => onJumpGtSource(sourceKey, criterion.criterionId)}
                >
                  查看 GT 来源：{gtLabels[sourceKey] ?? sourceKey}
                </button>
              ))}
            </div>
            <p className="evolution-preparation-next">下一步：{criterion.nextAction}</p>
          </div>
        </PreparationDetails>
      ))}
    </div>
  );
}
