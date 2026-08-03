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
  reevalStatusLabel,
} from '../eval-lifecycle-display';
import { HubEvalMetricGlossary } from '../HubEvalMetricGlossary';
import type { EvalLifecycleRef } from '../HubEvalTypes';
import type { EvalWorkspaceEvent, EvalWorkspaceEventKind } from './evalWorkspaceEvents';

const SETTINGS_EVAL_HUB_HREF = '/settings?ops=observability&obs=eval';

export function EvalWorkspaceEventCard({
  event,
  projectPath,
  worktreeId,
}: {
  event: EvalWorkspaceEvent;
  projectPath?: string;
  worktreeId?: string;
}) {
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setWorkspaceOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  const openWorkspaceFile = useCallback(
    (path: string) => {
      if (projectPath) setCurrentProject(projectPath);
      setWorkspaceMode('dev');
      setWorkspaceOpenFile(path, null, worktreeId ?? null);
    },
    [projectPath, setCurrentProject, setWorkspaceMode, setWorkspaceOpenFile, worktreeId],
  );

  return (
    <article className="rounded-lg bg-cafe-surface-elevated p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium text-cafe-muted">
            {event.domainDisplayName} · {event.domainId}
          </div>
          <h3 className="mt-1 break-words text-sm font-semibold text-cafe">{event.title}</h3>
        </div>
        <span className={`inline-flex shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold ${badgeClass(event.kind)}`}>
          {kindLabel(event)}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-cafe-secondary">{event.summary}</p>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <InfoTerm label="现在要做" value={event.action} />
        <InfoTerm label="下次看什么" value={formatNextCheck(event)} />
        {event.lifecycle.diagnosisTarget ? (
          <InfoTerm label="问题指向" value={formatDiagnosisTarget(event.lifecycle.diagnosisTarget)} />
        ) : null}
        {event.lifecycle.targetOwnerCatId ? (
          <InfoTerm label="负责处理" value={formatLifecycleOwner(event.lifecycle.targetOwnerCatId)} />
        ) : null}
        {event.lifecycle.taskId ? <InfoTerm label="责任任务" value={event.lifecycle.taskId} /> : null}
        {event.lifecycle.leaseId ? (
          <InfoTerm
            label="责任租约"
            value={`${event.lifecycle.leaseId}${event.lifecycle.leaseGeneration ? ` · generation ${event.lifecycle.leaseGeneration}` : ''}`}
          />
        ) : null}
        {event.lifecycle.mainCommitSha ? (
          <InfoTerm label="主干状态" value={`main · ${event.lifecycle.mainCommitSha}`} />
        ) : null}
        {event.lifecycle.liveCommitSha ? (
          <InfoTerm label="运行状态" value={`live · ${event.lifecycle.liveCommitSha}`} />
        ) : null}
        <InfoTerm label="跟进状态" value={ownerResponseLabel(event.lifecycle.ownerResponseStatus)} />
        <InfoTerm label="闭环进度" value={lifecycleStatusLabel(event.lifecycle.closureStatus)} />
        {event.lifecycle.reevalStatus ? (
          <InfoTerm label="复评状态" value={reevalStatusLabel(event.lifecycle.reevalStatus)} />
        ) : null}
      </dl>
      <LifecycleNotices event={event} />
      <LifecycleRefs label="修复证据" refs={event.lifecycle.actionRefs} />
      <LifecycleRefs label="复评证据" refs={event.lifecycle.reevalRefs} />
      <HubEvalMetricGlossary glossary={event.metricGlossary} />
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={SETTINGS_EVAL_HUB_HREF} className={navClassName}>
          查看台账
        </a>
        <NavButton onClick={() => openWorkspaceFile(event.source.verdictPath)}>结论文件</NavButton>
        <NavButton onClick={() => openWorkspaceFile(`${event.source.bundleDir}/snapshot.json`)}>快照包</NavButton>
        <NavButton onClick={() => openWorkspaceFile(`${event.source.bundleDir}/attribution.json`)}>归因包</NavButton>
        <a href={`/thread/${encodeURIComponent(event.systemThreadId)}`} className={navClassName}>
          工作线程
        </a>
      </div>
    </article>
  );
}

function LifecycleNotices({ event }: { event: EvalWorkspaceEvent }) {
  const { lifecycle } = event;
  if (lifecycle.availability === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
        处置记录暂不可用；结论和证据仍可查看。
      </div>
    );
  }
  return (
    <>
      {lifecycle.escalation ? (
        <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
          {escalationLabel(lifecycle.escalation)} · 原截止 {formatLifecycleDate(lifecycle.escalation.dueAt)}
        </div>
      ) : null}
      {lifecycle.closureReason ? (
        <p className="mt-3 text-xs leading-relaxed text-cafe-secondary">闭环说明：{lifecycle.closureReason}</p>
      ) : null}
      {(lifecycle.unavailableRefs?.length ?? 0) > 0 ? (
        <p className="mt-2 text-xs text-conn-amber-text">历史证据缺失 {lifecycle.unavailableRefs?.length} 段</p>
      ) : null}
    </>
  );
}

function LifecycleRefs({ label, refs = [] }: { label: string; refs?: EvalLifecycleRef[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-3 text-xs">
      <div className="text-cafe-muted">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {refs.map((ref, index) =>
          ref.availability === 'available' && /^https?:\/\//.test(ref.value) ? (
            <a key={`${ref.kind}-${index}`} href={ref.value} className="break-all underline underline-offset-2">
              {ref.value}
            </a>
          ) : (
            <code key={`${ref.kind}-${index}`} className="break-all rounded bg-cafe-surface px-1.5 py-0.5">
              {lifecycleRefText(ref)}
            </code>
          ),
        )}
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

function kindLabel(event: EvalWorkspaceEvent): string {
  if (event.kind === 'escalated' || event.kind === 'resolved') {
    return lifecycleStatusLabel(event.lifecycle.closureStatus);
  }
  if (event.kind === 'needs_decision') return '需要拍板';
  if (event.kind === 'needs_action') return '需要处理';
  if (event.kind === 'awaiting_reeval') return '待复评';
  return '观察中';
}

function badgeClass(kind: EvalWorkspaceEventKind): string {
  if (kind === 'escalated' || kind === 'needs_decision') return 'bg-conn-red-bg text-conn-red-text';
  if (kind === 'awaiting_reeval') return 'bg-conn-amber-bg text-conn-amber-text';
  if (kind === 'needs_action') return 'bg-[var(--console-button-emphasis)]/10 text-[var(--console-button-emphasis)]';
  return 'bg-cafe-surface text-cafe-secondary';
}

function formatNextCheck(event: EvalWorkspaceEvent): string {
  return event.nextEvalAt ? `${event.nextCheck} 原计划：${formatLifecycleDate(event.nextEvalAt)}。` : event.nextCheck;
}

const navClassName =
  'rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe';
