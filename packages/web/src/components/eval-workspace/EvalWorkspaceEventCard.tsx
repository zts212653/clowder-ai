'use client';

import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
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
} from '../eval-lifecycle-display';
import { HubEvalMetricGlossary } from '../HubEvalMetricGlossary';
import type { EvalLifecycleRef } from '../HubEvalTypes';
import { captureFileCardOrigin } from '../workbench/file-card-origin';
import { useFileCardReturn } from '../workbench/useFileCardReturn';
import { invocationIdFromEvidenceRef } from '../workspace/trajectory/invocation-evidence-ref';
import {
  findEvalWorkspaceEvent,
  findTrajectoryOriginScrollContainer,
  openInvocationTrajectory,
} from '../workspace/trajectory/trajectory-navigation';
import { evalWorkspaceCopy, useEvalCopy, useEvalLanguage } from './eval-workspace.shell-copy';
import type { EvalWorkspaceEvent, EvalWorkspaceEventKind } from './evalWorkspaceEvents';

const SETTINGS_EVAL_HUB_HREF = '/settings?ops=observability&obs=eval';

export function EvalWorkspaceEventCard({
  event,
  projectPath,
  worktreeId,
  onOpenLedger,
}: {
  event: EvalWorkspaceEvent;
  projectPath?: string;
  worktreeId?: string;
  /** Workspace opens its original ledger in place; classic standalone consumers retain the established Settings entry. */
  onOpenLedger?: () => void;
}) {
  const t = useEvalCopy();
  const language = useEvalLanguage();
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setWorkspaceOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const originRef = useFileCardReturn<HTMLElement>(`eval:${event.id}`, currentThreadId);
  const openWorkspaceFile = useCallback(
    (path: string) => {
      if (projectPath) setCurrentProject(projectPath);
      setWorkspaceMode('dev');
      setWorkspaceOpenFile(
        path,
        null,
        worktreeId ?? null,
        currentThreadId,
        captureFileCardOrigin(originRef.current, `eval:${event.id}`, currentThreadId, 'eval'),
      );
    },
    [
      projectPath,
      setCurrentProject,
      setWorkspaceMode,
      setWorkspaceOpenFile,
      worktreeId,
      currentThreadId,
      event.id,
      originRef,
    ],
  );
  const openTrajectoryEvidence = useCallback(
    (invocationId: string) => {
      if (!currentThreadId) return;
      const element = findEvalWorkspaceEvent(event.id);
      const container = findTrajectoryOriginScrollContainer(element);
      const viewportOffsetPx =
        element && container ? element.getBoundingClientRect().top - container.getBoundingClientRect().top : 0;
      openInvocationTrajectory({
        invocationId,
        originRef: {
          kind: 'eval',
          threadId: currentThreadId,
          eventId: event.id,
          viewportOffsetPx,
        },
      });
    },
    [currentThreadId, event.id],
  );

  return (
    <article
      ref={originRef}
      className="rounded-lg bg-cafe-surface-elevated p-4"
      data-eval-event-id={event.id}
      tabIndex={-1}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium text-cafe-muted">
            {event.domainDisplayName} · {event.domainId}
          </div>
          <h3 className="mt-1 break-words text-sm font-semibold text-cafe">{event.title}</h3>
        </div>
        <span className={`inline-flex shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold ${badgeClass(event.kind)}`}>
          {kindLabel(event, language)}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-cafe-secondary">{event.summary}</p>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <InfoTerm label={t.nowAction} value={event.action} />
        <InfoTerm label={t.nextCheck} value={formatNextCheck(event, language)} />
        {event.lifecycle.diagnosisTarget ? (
          <InfoTerm label={t.diagnosisTarget} value={formatDiagnosisTarget(event.lifecycle.diagnosisTarget)} />
        ) : null}
        {event.lifecycle.targetOwnerCatId ? (
          <InfoTerm label={t.owner} value={formatLifecycleOwner(event.lifecycle.targetOwnerCatId)} />
        ) : null}
        {event.lifecycle.taskId ? <InfoTerm label={t.task} value={event.lifecycle.taskId} /> : null}
        {event.lifecycle.leaseId ? (
          <InfoTerm
            label={t.lease}
            value={`${event.lifecycle.leaseId}${event.lifecycle.leaseGeneration ? ` · generation ${event.lifecycle.leaseGeneration}` : ''}`}
          />
        ) : null}
        {event.lifecycle.mainCommitSha ? (
          <InfoTerm label={t.mainStatus} value={`main · ${event.lifecycle.mainCommitSha}`} />
        ) : null}
        {event.lifecycle.liveCommitSha ? (
          <InfoTerm label={t.liveStatus} value={`live · ${event.lifecycle.liveCommitSha}`} />
        ) : null}
        <InfoTerm label={t.followup} value={ownerResponseLabel(event.lifecycle.ownerResponseStatus, language)} />
        {event.lifecycle.repairDebtStatus ? (
          <InfoTerm label={t.repairDebt} value={repairDebtLabel(event.lifecycle.repairDebtStatus, language)} />
        ) : null}
        {event.lifecycle.reevalDebtStatus ? (
          <InfoTerm label={t.reevalDebt} value={reevalDebtLabel(event.lifecycle.reevalDebtStatus, language)} />
        ) : null}
        {event.lifecycle.reevalTaskId ? <InfoTerm label={t.reevalTask} value={event.lifecycle.reevalTaskId} /> : null}
        <InfoTerm label={t.closure} value={lifecycleStatusLabel(event.lifecycle.closureStatus, language)} />
        {event.lifecycle.reevalStatus ? (
          <InfoTerm label={t.reevalStatus} value={reevalStatusLabel(event.lifecycle.reevalStatus, language)} />
        ) : null}
      </dl>
      <LifecycleNotices event={event} />
      <LifecycleRefs
        label={t.repairEvidence}
        refs={event.lifecycle.actionRefs}
        onOpenInvocation={openTrajectoryEvidence}
      />
      <LifecycleRefs
        label={t.reevalEvidence}
        refs={event.lifecycle.reevalRefs}
        onOpenInvocation={openTrajectoryEvidence}
      />
      <HubEvalMetricGlossary glossary={event.metricGlossary} />
      <div className="mt-3 flex flex-wrap gap-2">
        {onOpenLedger ? (
          <NavButton onClick={onOpenLedger}>{t.openLedger}</NavButton>
        ) : (
          <a href={SETTINGS_EVAL_HUB_HREF} className={navClassName}>
            {t.viewLedger}
          </a>
        )}
        <NavButton onClick={() => openWorkspaceFile(event.source.verdictPath)}>{t.verdictFile}</NavButton>
        <NavButton onClick={() => openWorkspaceFile(`${event.source.bundleDir}/snapshot.json`)}>{t.snapshot}</NavButton>
        <NavButton onClick={() => openWorkspaceFile(`${event.source.bundleDir}/attribution.json`)}>
          {t.attribution}
        </NavButton>
        <a href={`/thread/${encodeURIComponent(event.systemThreadId)}`} className={navClassName}>
          {t.workThread}
        </a>
      </div>
    </article>
  );
}

function LifecycleNotices({ event }: { event: EvalWorkspaceEvent }) {
  const t = useEvalCopy();
  const language = useEvalLanguage();
  const { lifecycle } = event;
  if (lifecycle.availability === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
        {t.missingLifecycle}
      </div>
    );
  }
  return (
    <>
      {lifecycle.escalation ? (
        <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
          {escalationLabel(lifecycle.escalation, language)} · {t.originalDeadline}{' '}
          {formatLifecycleDate(lifecycle.escalation.dueAt, language)}
        </div>
      ) : null}
      {lifecycle.closureReason ? (
        <p className="mt-3 text-xs leading-relaxed text-cafe-secondary">
          {t.closureReason}: {lifecycle.closureReason}
        </p>
      ) : null}
      {(lifecycle.unavailableRefs?.length ?? 0) > 0 ? (
        <p className="mt-2 text-xs text-conn-amber-text">
          {t.missingHistoryCount(lifecycle.unavailableRefs?.length ?? 0)}
        </p>
      ) : null}
    </>
  );
}

function invocationIdFromRef(ref: EvalLifecycleRef): string | undefined {
  if (ref.availability !== 'available') return undefined;
  return invocationIdFromEvidenceRef(ref.value);
}

function LifecycleRefs({
  label,
  refs = [],
  onOpenInvocation,
}: {
  label: string;
  refs?: EvalLifecycleRef[];
  onOpenInvocation?: (invocationId: string) => void;
}) {
  const t = useEvalCopy();
  const language = useEvalLanguage();
  if (refs.length === 0) return null;
  return (
    <div className="mt-3 text-xs">
      <div className="text-cafe-muted">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {refs.map((ref, index) => {
          const invocationId = ref.availability === 'available' ? invocationIdFromRef(ref) : undefined;
          return invocationId && onOpenInvocation ? (
            <button
              type="button"
              key={`${ref.kind}-${index}`}
              onClick={() => onOpenInvocation(invocationId)}
              className="inline-flex items-center gap-1 rounded-md border border-cafe bg-cafe-surface px-2 py-1 text-xs font-semibold text-cafe-secondary hover:text-cafe-accent"
              data-testid="trajectory-evidence-chip"
              data-invocation-id={invocationId}
            >
              <svg
                aria-hidden="true"
                className="h-3 w-3"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="4" cy="4" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
              </svg>
              {t.invocationTrace}
            </button>
          ) : ref.availability === 'available' && /^https?:\/\//.test(ref.value) ? (
            <a
              key={`${ref.kind}-${index}`}
              href={ref.value}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline underline-offset-2"
            >
              {ref.value}
            </a>
          ) : (
            <code key={`${ref.kind}-${index}`} className="break-all rounded bg-cafe-surface px-1.5 py-0.5">
              {lifecycleRefText(ref, language)}
            </code>
          );
        })}
      </div>
    </div>
  );
}

function InfoTerm({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-cafe-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-cafe-secondary">{value}</dd>
    </div>
  );
}

function NavButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={navClassName}>
      {children}
    </button>
  );
}

function kindLabel(event: EvalWorkspaceEvent, language: 'zh' | 'en'): string {
  const t = evalWorkspaceCopy[language];
  if (event.kind === 'escalated' || event.kind === 'resolved') {
    return lifecycleStatusLabel(event.lifecycle.closureStatus, language);
  }
  if (event.kind === 'needs_decision') return t.kindDecision;
  if (event.kind === 'needs_action') return t.kindAction;
  if (event.kind === 'awaiting_reeval') return t.kindReeval;
  return t.kindWatching;
}

function badgeClass(kind: EvalWorkspaceEventKind): string {
  if (kind === 'escalated' || kind === 'needs_decision') return 'bg-conn-red-bg text-conn-red-text';
  if (kind === 'awaiting_reeval') return 'bg-conn-amber-bg text-conn-amber-text';
  if (kind === 'needs_action') return 'bg-[var(--console-button-emphasis)]/10 text-[var(--console-button-emphasis)]';
  return 'bg-cafe-surface text-cafe-secondary';
}

function formatNextCheck(event: EvalWorkspaceEvent, language: 'zh' | 'en'): string {
  const t = evalWorkspaceCopy[language];
  return event.nextEvalAt
    ? `${event.nextCheck} ${t.originalSchedule}: ${formatLifecycleDate(event.nextEvalAt, language)}`
    : event.nextCheck;
}

const navClassName =
  'rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe';
