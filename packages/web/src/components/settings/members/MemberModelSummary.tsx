import type { MemberText } from './MemberRuntimeFields';

/** Values and their provenance remain visible independently of model-list discovery. */
export function MemberModelSummary({
  model,
  effort,
  modelSource,
  effortSource,
  unavailable,
  notImplemented = false,
  noEffortOptions,
  stale,
  t,
}: {
  model?: string;
  effort?: string;
  modelSource: string;
  effortSource: string;
  unavailable: boolean;
  notImplemented?: boolean;
  noEffortOptions: boolean;
  stale: boolean;
  t: MemberText;
}) {
  const unknown = notImplemented
    ? t('尚未接入读取', 'Reading is not implemented for this entry')
    : unavailable
      ? t('暂不可读取', 'Temporarily unavailable')
      : t('客户端未上报', 'Not reported by the client');
  const previous = stale ? t('上次读取 · ', 'Previously read · ') : '';
  return (
    <div className="space-y-1" data-testid="member-model-summary">
      <p>
        {t('模型', 'Model')}：{model !== undefined ? `${model} · ${previous}${modelSource}` : unknown}
      </p>
      <p>
        {t('思考强度', 'Reasoning effort')}：
        {effort !== undefined
          ? `${effort || t('客户端默认', 'Client default')} · ${previous}${effortSource}`
          : noEffortOptions
            ? t('未提供独立强度档位', 'No separate effort levels advertised')
            : unknown}
      </p>
    </div>
  );
}
