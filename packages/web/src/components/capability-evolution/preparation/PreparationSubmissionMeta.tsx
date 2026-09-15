import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionPreparationSubmissionProjection } from './evolution-preparation-resource';

const SOURCE_STATUS = {
  materializing: '需恢复',
  submitted: '已提交',
  needs_update: '需更新',
  source_unavailable: '来源不可用',
  source_invalid: '来源校验失败',
} as const;

export function SubmissionHeader({ value }: { value: EvolutionPreparationSubmissionProjection }) {
  return (
    <header className="evolution-preparation-submission-header">
      <div>
        <span className="evolution-preparation-kicker">准备草案 · 不等于验证</span>
        <h3>{value.submission?.title ?? '提交记录'}</h3>
      </div>
      <span className="evolution-preparation-source-status" data-source-status={value.status}>
        {SOURCE_STATUS[value.status]}
      </span>
    </header>
  );
}

export function SubmissionMeta({ value }: { value: EvolutionPreparationSubmissionProjection }) {
  return (
    <details className="evolution-preparation-provenance">
      <summary>来源与修订</summary>
      <dl className="evolution-preparation-facts">
        <div>
          <dt>作者</dt>
          <dd>{value.authorCatId ?? '未能核验'}</dd>
        </div>
        <div>
          <dt>提交时间</dt>
          <dd>
            <time dateTime={value.occurredAt}>{new Date(value.occurredAt).toLocaleString('zh-CN')}</time>
          </dd>
        </div>
        <div>
          <dt>精确修订</dt>
          <dd className="evolution-preparation-revision">{value.ref.version}</dd>
        </div>
        <div>
          <dt>来源位置</dt>
          <dd>{value.threadId && value.messageId ? `${value.threadId}#${value.messageId}` : '来源位置尚不可用'}</dd>
        </div>
      </dl>
      {value.dependencies.map((source, index) => (
        <EvolutionSource key={`${source.ownerStateRef}:${source.version}:${index}`} label="依赖修订" source={source} />
      ))}
    </details>
  );
}
