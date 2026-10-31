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
import { evalDetailCopy, useEvalDetailCopy } from './eval-workspace/eval-detail.shell-copy';
import { useEvalCopy, useEvalLanguage } from './eval-workspace/eval-workspace.shell-copy';
import type { EvalHubLifecycleView, EvalLifecycleRef } from './HubEvalTypes';

export function HubEvalLifecycleSummary({
  lifecycle,
  openWorkspaceFile,
}: {
  lifecycle: EvalHubLifecycleView;
  openWorkspaceFile?: (path: string) => void;
}) {
  const detail = useEvalDetailCopy();
  const language = useEvalLanguage();
  return (
    <section className="mt-4 rounded-lg border border-cafe bg-cafe-surface px-3 py-3" aria-label={detail.progress}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-cafe">{detail.progress}</h4>
        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusBadgeClass(lifecycle)}`}>
          {lifecycleStatusLabel(lifecycle.closureStatus, language)}
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
  const detail = useEvalDetailCopy();
  if (lifecycle.availability === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2">
        <p className="text-xs font-medium text-conn-amber-text">{detail.unavailable}</p>
        <p className="mt-1 text-xs leading-relaxed text-conn-amber-text">{detail.unavailableHint}</p>
      </div>
    );
  }
  if (lifecycle.availability === 'not_required') {
    return <p className="mt-2 text-xs leading-relaxed text-cafe-secondary">{detail.notRequired}</p>;
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
  const detail = useEvalDetailCopy();
  const t = useEvalCopy();
  const language = useEvalLanguage();
  const unavailableRefs = lifecycle.unavailableRefs ?? [];
  return (
    <>
      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        {lifecycle.diagnosisTarget ? (
          <LifecycleTerm label={t.diagnosisTarget} value={formatDiagnosisTarget(lifecycle.diagnosisTarget)} />
        ) : null}
        {lifecycle.targetOwnerCatId ? (
          <LifecycleTerm label={t.owner} value={formatLifecycleOwner(lifecycle.targetOwnerCatId)} />
        ) : null}
        {lifecycle.taskId ? <LifecycleTerm label={t.task} value={lifecycle.taskId} /> : null}
        {lifecycle.leaseId ? (
          <LifecycleTerm
            label={t.lease}
            value={`${lifecycle.leaseId}${lifecycle.leaseGeneration ? ` · generation ${lifecycle.leaseGeneration}` : ''}`}
          />
        ) : null}
        {lifecycle.mainCommitSha ? (
          <LifecycleTerm label={t.mainStatus} value={`main · ${lifecycle.mainCommitSha}`} />
        ) : null}
        {lifecycle.liveCommitSha ? (
          <LifecycleTerm label={t.liveStatus} value={`live · ${lifecycle.liveCommitSha}`} />
        ) : null}
        {lifecycle.caseId ? (
          <LifecycleTerm
            label={detail.case}
            value={t.caseCycles(lifecycle.caseId, lifecycle.observedVerdictIds?.length ?? 1)}
          />
        ) : null}
        <LifecycleTerm label={detail.acceptance} value={ownerResponseLabel(lifecycle.ownerResponseStatus, language)} />
        {lifecycle.repairDebtStatus ? (
          <LifecycleTerm label={t.repairDebt} value={repairDebtLabel(lifecycle.repairDebtStatus, language)} />
        ) : null}
        {lifecycle.reevalDebtStatus ? (
          <LifecycleTerm label={t.reevalDebt} value={reevalDebtLabel(lifecycle.reevalDebtStatus, language)} />
        ) : null}
        {lifecycle.reevalTaskId ? <LifecycleTerm label={t.reevalTask} value={lifecycle.reevalTaskId} /> : null}
        {lifecycle.reevalLeaseId ? (
          <LifecycleTerm
            label={detail.reevalLease}
            value={`${lifecycle.reevalLeaseId}${lifecycle.reevalLeaseGeneration ? ` · generation ${lifecycle.reevalLeaseGeneration}` : ''}`}
          />
        ) : null}
        <LifecycleTerm label={t.reevalStatus} value={formatReevalStatus(lifecycle, language)} />
      </dl>
      {lifecycle.responsibilityBlocker ? (
        <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
          <div className="font-medium">
            {detail.routingRestore} · {lifecycle.responsibilityBlocker.featureId}
          </div>
          <p className="mt-1 leading-relaxed">
            {lifecycle.responsibilityBlocker.reasonCode === 'feature_thread_not_found'
              ? detail.threadMissing
              : t.multipleThreads(lifecycle.responsibilityBlocker.candidateThreadIds.join(', '))}
          </p>
        </div>
      ) : null}
      {lifecycle.custodyDispatchBlocker ? (
        <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
          <div className="font-medium">
            {detail.carrierRestore} ·{' '}
            {lifecycle.custodyDispatchBlocker.stage === 'reevaluation' ? detail.reeval : detail.responsibility}
          </div>
          <p className="mt-1 leading-relaxed">
            {t.carrierTask(lifecycle.custodyDispatchBlocker.stage)}
            {lifecycle.custodyDispatchBlocker.reasonCode === 'carrier_persist_failed'
              ? detail.carrierPersistFailed
              : lifecycle.custodyDispatchBlocker.reasonCode === 'carrier_delivery_failed'
                ? detail.carrierDeliveryFailed
                : detail.carrierQueueFailed}
            · {detail.retry}
          </p>
          <div className="mt-1">
            task · {lifecycle.custodyDispatchBlocker.taskId}
            {' · '}lease · {lifecycle.custodyDispatchBlocker.leaseId} · generation{' '}
            {lifecycle.custodyDispatchBlocker.leaseGeneration}
          </div>
        </div>
      ) : null}
      {lifecycle.escalation ? (
        <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
          <span className="font-medium">{escalationLabel(lifecycle.escalation, language)}</span>
          <span>
            {' '}
            · {t.originalDeadline} {formatLifecycleDate(lifecycle.escalation.dueAt, language)}
          </span>
        </div>
      ) : null}
      {lifecycle.closureReason ? (
        <div className="mt-3 text-xs">
          <div className="text-cafe-muted">{t.closureReason}</div>
          <p className="mt-1 leading-relaxed text-cafe-secondary">{lifecycle.closureReason}</p>
        </div>
      ) : null}
      <div className="mt-3 space-y-2">
        <ReferenceGroup
          label={detail.acceptanceEvidence}
          refs={lifecycle.ownerResponseRefs}
          openWorkspaceFile={openWorkspaceFile}
        />
        <ReferenceGroup label={detail.plan} refs={lifecycle.planRefs} openWorkspaceFile={openWorkspaceFile} />
        <ReferenceGroup label={t.repairEvidence} refs={lifecycle.actionRefs} openWorkspaceFile={openWorkspaceFile} />
        <ReferenceGroup label={t.reevalEvidence} refs={lifecycle.reevalRefs} openWorkspaceFile={openWorkspaceFile} />
      </div>
      {unavailableRefs.length > 0 ? (
        <details className="mt-3 rounded-md border border-conn-amber-ring px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-conn-amber-text">
            {t.missingHistoryCount(unavailableRefs.length)}
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
  const language = useEvalLanguage();
  return (
    <ul className="mt-1 space-y-1">
      {refs.map((ref, index) => (
        <li
          key={`${ref.kind}-${lifecycleRefText(ref, language)}-${index}`}
          className="break-all text-xs text-cafe-secondary"
        >
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
            <code>{lifecycleRefText(ref, language)}</code>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatReevalStatus(lifecycle: EvalHubLifecycleView, language: 'zh' | 'en'): string {
  const detail = evalDetailCopy[language];
  const label = reevalStatusLabel(lifecycle.reevalStatus, language);
  return lifecycle.reevalDueAt
    ? `${label} · ${detail.deadline} ${formatLifecycleDate(lifecycle.reevalDueAt, language)}`
    : label;
}

function statusBadgeClass(lifecycle: EvalHubLifecycleView): string {
  if (lifecycle.closureStatus === 'escalated') return 'bg-conn-red-bg text-conn-red-text';
  if (lifecycle.closureStatus === 'unavailable') return 'bg-conn-amber-bg text-conn-amber-text';
  return 'bg-cafe-surface-elevated text-[var(--console-button-emphasis)]';
}
