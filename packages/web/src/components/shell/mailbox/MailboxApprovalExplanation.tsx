import { type ApprovalHubItem, evalRepairDecisionExplanationV1Schema } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

const EFFECT: Partial<Record<ApprovalHubItem['sourceFeatureId'], string>> = {
  F128: '按提议创建对话。',
  F193: '把这条工作交给提议中的执行者。',
  F139: '按提议设置定时任务。',
  F221: '保存这条品味。',
  F260: '按提议登记或更新实体。',
  F266: '采用这条评估修复提议。',
  F321: '采用这条记忆整理提议。',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function targetVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return text((value as Record<string, unknown>).version);
}

function F266DecisionExplanation({ item }: { item: ApprovalHubItem }) {
  const detail = item.detail;
  const parsed = evalRepairDecisionExplanationV1Schema.safeParse(detail.decisionExplanation);
  const explanation: Record<string, unknown> = parsed.success ? parsed.data : detail;
  const rejected = Array.isArray(explanation.rejectedCandidates)
    ? explanation.rejectedCandidates.filter((value): value is string => Boolean(text(value)))
    : [];
  const fields = [
    ['成套改动', text(explanation.changeSetSummary)],
    ['归因边界', text(explanation.attributionBoundary)],
    ['独立验证', text(explanation.independentVerification)],
    ['成本与回滚', text(explanation.costAndRollback) ?? text(detail.costAndRollback)],
    ['撤回条件', text(detail.withdrawalCondition)],
    ['精确目标', targetVersion(detail.targetVersionRef)],
  ] as const;
  return (
    <div className="space-y-3 text-sm" data-testid="mailbox-evolution-decision-explanation">
      <div>
        <p className="m-0 font-medium">这次只批准一件事</p>
        <p className="m-0 whitespace-pre-wrap break-words">
          {text(explanation.expectedChange) ?? text(detail.expectedChange) ?? '原提议未说明要批准的 exact change'}
        </p>
      </div>
      {(text(explanation.beforeSummary) || text(explanation.afterSummary)) && (
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="font-medium">之前</dt>
            <dd className="m-0">{text(explanation.beforeSummary) ?? '未提供'}</dd>
          </div>
          <div>
            <dt className="font-medium">同意后预期</dt>
            <dd className="m-0">{text(explanation.afterSummary) ?? '未提供'}</dd>
          </div>
        </dl>
      )}
      <dl className="space-y-2">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{value ?? '原提议未提供'}</dd>
          </div>
        ))}
        <div>
          <dt className="font-medium">没有采用的候选</dt>
          <dd className="m-0">
            {rejected.length ? (
              <ul className="m-0 list-disc pl-5">
                {rejected.map((candidate) => (
                  <li key={candidate}>{candidate}</li>
                ))}
              </ul>
            ) : (
              '原提议未提供'
            )}
          </dd>
        </div>
      </dl>
      <p className="m-0">同意后：{EFFECT.F266}</p>
    </div>
  );
}

/** Only producer-supplied words identify the reason and executor. Absence is displayed, never filled with an invented claim. */
export function MailboxApprovalExplanation({ item }: { item: ApprovalHubItem }) {
  const name = useCatNameResolver();
  if (item.sourceFeatureId === 'F266') return <F266DecisionExplanation item={item} />;
  const reason = ['reason', 'rationale', 'content', 'takeaway', 'description']
    .map((key) => item.detail[key])
    .find((value) => typeof value === 'string' && value.trim());
  const cats = item.detail.targetCats ?? item.detail.preferredCats;
  const executors =
    Array.isArray(cats) && cats.every((cat) => typeof cat === 'string') ? cats.map(name).join('、') : '';
  return (
    <div className="space-y-2 text-sm" data-testid="mailbox-proposal-explanation">
      <p className="m-0">提议者：{name(item.requesterCatId)}</p>
      <div>
        <p className="m-0 font-medium">为什么</p>
        <p className="m-0 whitespace-pre-wrap break-words">
          {typeof reason === 'string' ? reason : '原提议未说明原因'}
        </p>
      </div>
      <p className="m-0">执行者：{executors || '原提议未指定'}</p>
      <p className="m-0">同意后：{EFFECT[item.sourceFeatureId] ?? '按原提议执行；结果以实际回执为准。'}</p>
    </div>
  );
}
