import {
  escalationLabel,
  formatDiagnosisTarget,
  formatLifecycleDate,
  formatLifecycleOwner,
  lifecycleRefText,
  lifecycleStatusLabel,
  ownerResponseLabel,
  reevalDebtLabel,
  reevalStatusLabel,
  repairDebtLabel,
} from './eval-lifecycle-display';
import type { EvalHubLifecycleView, EvalLifecycleRef } from './HubEvalTypes';

export function HubEvalLifecycleSummary({
  lifecycle,
  openWorkspaceFile,
}: {
  lifecycle: EvalHubLifecycleView;
  openWorkspaceFile?: (path: string) => void;
}) {
  return (
    <section className="mt-4 rounded-lg border border-cafe bg-cafe-surface px-3 py-3" aria-label="处置进度">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-cafe">处置进度</h4>
        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusBadgeClass(lifecycle)}`}>
          {lifecycleStatusLabel(lifecycle.closureStatus)}
        </span>
      </div>

      <LifecycleBody lifecycle={lifecycle} openWorkspaceFile={openWorkspaceFile} />
    </section>
  );
}

function LifecycleBody({
  lifecycle,
  openWorkspaceFile,
}: {
  lifecycle: EvalHubLifecycleView;
  openWorkspaceFile?: (path: string) => void;
}) {
  if (lifecycle.availability === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2">
        <p className="text-xs font-medium text-conn-amber-text">处置记录暂不可用</p>
        <p className="mt-1 text-xs leading-relaxed text-conn-amber-text">
          结论和证据仍可查看；恢复 canonical lifecycle 存储后再补齐处置进度。
        </p>
      </div>
    );
  }
  if (lifecycle.availability === 'not_required') {
    return (
      <p className="mt-2 text-xs leading-relaxed text-cafe-secondary">这条结论无需进入处置链，按现有节奏持续观察。</p>
    );
  }
  return <AvailableLifecycleDetails lifecycle={lifecycle} openWorkspaceFile={openWorkspaceFile} />;
}

function AvailableLifecycleDetails({
  lifecycle,
  openWorkspaceFile,
}: {
  lifecycle: EvalHubLifecycleView;
  openWorkspaceFile?: (path: string) => void;
}) {
  const unavailableRefs = lifecycle.unavailableRefs ?? [];
  return (
    <>
      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        {lifecycle.diagnosisTarget ? (
          <LifecycleTerm label="问题指向" value={formatDiagnosisTarget(lifecycle.diagnosisTarget)} />
        ) : null}
        {lifecycle.targetOwnerCatId ? (
          <LifecycleTerm label="负责处理" value={formatLifecycleOwner(lifecycle.targetOwnerCatId)} />
        ) : null}
        {lifecycle.taskId ? <LifecycleTerm label="责任任务" value={lifecycle.taskId} /> : null}
        {lifecycle.leaseId ? (
          <LifecycleTerm
            label="责任租约"
            value={`${lifecycle.leaseId}${lifecycle.leaseGeneration ? ` · generation ${lifecycle.leaseGeneration}` : ''}`}
          />
        ) : null}
        {lifecycle.mainCommitSha ? (
          <LifecycleTerm label="主干状态" value={`main · ${lifecycle.mainCommitSha}`} />
        ) : null}
        {lifecycle.liveCommitSha ? (
          <LifecycleTerm label="运行状态" value={`live · ${lifecycle.liveCommitSha}`} />
        ) : null}
        {lifecycle.caseId ? (
          <LifecycleTerm
            label="稳定工单"
            value={`${lifecycle.caseId} · ${lifecycle.observedVerdictIds?.length ?? 1} 个周期`}
          />
        ) : null}
        <LifecycleTerm label="接单状态" value={ownerResponseLabel(lifecycle.ownerResponseStatus)} />
        {lifecycle.repairDebtStatus ? (
          <LifecycleTerm label="修复债务" value={repairDebtLabel(lifecycle.repairDebtStatus)} />
        ) : null}
        {lifecycle.reevalDebtStatus ? (
          <LifecycleTerm label="节奏 / 复评债务" value={reevalDebtLabel(lifecycle.reevalDebtStatus)} />
        ) : null}
        {lifecycle.reevalTaskId ? <LifecycleTerm label="复评任务" value={lifecycle.reevalTaskId} /> : null}
        {lifecycle.reevalLeaseId ? (
          <LifecycleTerm
            label="复评租约"
            value={`${lifecycle.reevalLeaseId}${lifecycle.reevalLeaseGeneration ? ` · generation ${lifecycle.reevalLeaseGeneration}` : ''}`}
          />
        ) : null}
        <LifecycleTerm label="复评状态" value={formatReevalStatus(lifecycle)} />
      </dl>
      {lifecycle.responsibilityBlocker ? (
        <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
          <div className="font-medium">责任路由待恢复 · {lifecycle.responsibilityBlocker.featureId}</div>
          <p className="mt-1 leading-relaxed">
            {lifecycle.responsibilityBlocker.reasonCode === 'feature_thread_not_found'
              ? '尚未找到唯一归属 thread；系统会在路由真相补齐后原位重试。'
              : `发现多个归属 thread（${lifecycle.responsibilityBlocker.candidateThreadIds.join('、')}）；明确唯一归属后系统会原位重试。`}
          </p>
        </div>
      ) : null}
      {lifecycle.escalation ? (
        <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
          <span className="font-medium">{escalationLabel(lifecycle.escalation)}</span>
          <span> · 原截止 {formatLifecycleDate(lifecycle.escalation.dueAt)}</span>
        </div>
      ) : null}
      {lifecycle.closureReason ? (
        <div className="mt-3 text-xs">
          <div className="text-cafe-muted">闭环说明</div>
          <p className="mt-1 leading-relaxed text-cafe-secondary">{lifecycle.closureReason}</p>
        </div>
      ) : null}
      <div className="mt-3 space-y-2">
        <ReferenceGroup label="接单证据" refs={lifecycle.ownerResponseRefs} openWorkspaceFile={openWorkspaceFile} />
        <ReferenceGroup label="行动计划" refs={lifecycle.planRefs} openWorkspaceFile={openWorkspaceFile} />
        <ReferenceGroup label="修复证据" refs={lifecycle.actionRefs} openWorkspaceFile={openWorkspaceFile} />
        <ReferenceGroup label="复评证据" refs={lifecycle.reevalRefs} openWorkspaceFile={openWorkspaceFile} />
      </div>
      {unavailableRefs.length > 0 ? (
        <details className="mt-3 rounded-md border border-conn-amber-ring px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-conn-amber-text">
            历史证据缺失 {unavailableRefs.length} 段
          </summary>
          <ReferenceList refs={unavailableRefs} />
        </details>
      ) : null}
    </>
  );
}

function LifecycleTerm({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-cafe-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-cafe-secondary">{value}</dd>
    </div>
  );
}

function ReferenceGroup({
  label,
  refs = [],
  openWorkspaceFile,
}: {
  label: string;
  refs?: EvalLifecycleRef[];
  openWorkspaceFile?: (path: string) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-cafe-muted">{label}</div>
      <ReferenceList refs={refs} openWorkspaceFile={openWorkspaceFile} />
    </div>
  );
}

function ReferenceList({
  refs,
  openWorkspaceFile,
}: {
  refs: EvalLifecycleRef[];
  openWorkspaceFile?: (path: string) => void;
}) {
  return (
    <ul className="mt-1 space-y-1">
      {refs.map((ref, index) => (
        <li key={`${ref.kind}-${lifecycleRefText(ref)}-${index}`} className="break-all text-xs text-cafe-secondary">
          {ref.availability === 'available' && /^https?:\/\//.test(ref.value) ? (
            <a
              href={ref.value}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-cafe-muted underline-offset-2 hover:text-cafe"
            >
              {ref.value}
            </a>
          ) : ref.availability === 'available' && ref.value.startsWith('docs/') && openWorkspaceFile ? (
            <button
              type="button"
              onClick={() => openWorkspaceFile(ref.value)}
              className="text-left underline underline-offset-2"
            >
              {ref.value}
            </button>
          ) : (
            <code>{lifecycleRefText(ref)}</code>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatReevalStatus(lifecycle: EvalHubLifecycleView): string {
  const label = reevalStatusLabel(lifecycle.reevalStatus);
  return lifecycle.reevalDueAt ? `${label} · 截止 ${formatLifecycleDate(lifecycle.reevalDueAt)}` : label;
}

function statusBadgeClass(lifecycle: EvalHubLifecycleView): string {
  if (lifecycle.closureStatus === 'escalated') return 'bg-conn-red-bg text-conn-red-text';
  if (lifecycle.closureStatus === 'unavailable') return 'bg-conn-amber-bg text-conn-amber-text';
  return 'bg-cafe-surface-elevated text-[var(--console-button-emphasis)]';
}
