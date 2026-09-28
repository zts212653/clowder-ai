import type { EvolutionPreparationBodyV1 } from '@cat-cafe/shared';
import { jumpToApprovalAnchor } from '@/components/ApprovalProvenanceLinks';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionPreparationSubmissionProjection } from './evolution-preparation-resource';

type GtSource = Extract<EvolutionPreparationBodyV1, { kind: 'measurement_plan' }>['gtSources'][number];

const CATEGORY = {
  business_fact: '业务原始事实',
  domain_precedent: '领域判断',
  real_world_outcome: '真实使用与后果',
} as const;
const COLLECTION = {
  not_connected: '待接通',
  collecting: '采集中',
  collected: '已采集',
} as const;
const VALIDITY = {
  unknown: '可信性未知',
  needs_review: '待核验',
  bounded: '可用于明确范围',
} as const;

export function gtSourceElementId(programId: string, sourceKey: string): string {
  return `evolution-preparation-gt-${programId}-${sourceKey}`;
}

export function EvolutionPreparationGtSources({
  programId,
  sources,
  focusedSourceKey,
  submission,
}: {
  programId: string;
  sources: GtSource[];
  focusedSourceKey?: string;
  submission?: EvolutionPreparationSubmissionProjection;
}) {
  return (
    <div className="evolution-preparation-gt-sources">
      {sources.map((source) => {
        const evidence = submission?.evidenceSources?.find((value) => value.sourceKey === source.sourceKey);
        const readStatus = evidence?.status ?? 'unverified';
        const bounded =
          source.validity.state === 'bounded' && readStatus === 'available' && submission?.status === 'submitted';
        return (
          <article
            key={source.sourceKey}
            id={gtSourceElementId(programId, source.sourceKey)}
            tabIndex={-1}
            className="evolution-preparation-gt-source"
            data-gt-source-key={source.sourceKey}
            data-focused={focusedSourceKey === source.sourceKey ? 'true' : undefined}
          >
            <header>
              <div>
                <span className="evolution-preparation-kicker">{CATEGORY[source.category]}</span>
                <h4>{source.label}</h4>
              </div>
              <div className="evolution-preparation-dual-status">
                <span data-collection-state={source.collection.state}>
                  <span className="sr-only">采集：</span>
                  {COLLECTION[source.collection.state]}
                </span>
                <span
                  data-validity-state={
                    source.validity.state === 'bounded' && !bounded ? 'unconfirmed' : source.validity.state
                  }
                >
                  <span className="sr-only">可信性：</span>
                  {source.validity.state === 'bounded' && !bounded ? '范围声明待核实' : VALIDITY[source.validity.state]}
                </span>
              </div>
            </header>
            {readStatus !== 'available' && source.collection.state !== 'not_connected' && (
              <p role="status" className="evolution-preparation-alert">
                {readStatus === 'unavailable'
                  ? '来源缺失或不可读，当前无法判定。'
                  : '当前来源尚未核读，保留提交者的范围声明，暂不能确认当前有效。'}
              </p>
            )}
            <dl className="evolution-preparation-facts">
              <div>
                <dt>怎样采集</dt>
                <dd>{source.collection.method}</dd>
              </div>
              <div>
                <dt>采集与校准依据</dt>
                <dd>{source.validity.detail}</dd>
              </div>
              {source.validity.state === 'bounded' && (
                <div>
                  <dt>{bounded ? '可用于' : '原声明适用范围'}</dt>
                  <dd>{source.validity.validFor}</dd>
                </div>
              )}
              <div>
                <dt>付薪与成本</dt>
                <dd>
                  {source.cost.payer} · {source.cost.detail}
                </dd>
              </div>
            </dl>
            {source.collection.state !== 'not_connected' && source.collection.sourceRef && (
              <EvolutionSource label="采集来源" source={source.collection.sourceRef} />
            )}
            {source.validity.state !== 'unknown' &&
              source.validity.proofRefs?.map((proof, index) => (
                <EvolutionSource
                  key={`${proof.ownerFeatureId}:${proof.ownerStateRef}:${index}`}
                  label="可信性依据"
                  source={proof}
                />
              ))}
            {evidence?.refs
              .filter((value) => value.status === 'available' && value.threadId && value.messageId)
              .map((value, i) => (
                <button
                  key={i}
                  type="button"
                  className="evolution-link"
                  onClick={() => jumpToApprovalAnchor(value.threadId!, value.messageId!)}
                >
                  回读取证原文
                </button>
              ))}
            {source.missingOrDisputed.length > 0 && (
              <div className="evolution-preparation-unknowns">
                <strong>缺失或分歧</strong>
                <ul>
                  {source.missingOrDisputed.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
