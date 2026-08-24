'use client';

import { metricRefKeyCandidates } from '@cat-cafe/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { currentEvalDueAt } from './eval-lifecycle-display';
import { HubEvalFrictionSections } from './HubEvalFrictionSections';
import { HubEvalLifecycleSummary } from './HubEvalLifecycleSummary';
import { type EvalHubItem, type EvalMetricGlossary, VERDICT_LABELS } from './HubEvalTypes';
import { invocationIdFromEvidenceRef } from './workspace/trajectory/invocation-evidence-ref';
import {
  findEvalWorkspaceEvent,
  findTrajectoryOriginScrollContainer,
  openInvocationTrajectory,
} from './workspace/trajectory/trajectory-navigation';

export function HubEvalVerdictCard({
  item,
  metricGlossary,
  projectPath,
  worktreeId,
}: {
  item: EvalHubItem;
  metricGlossary?: EvalMetricGlossary;
  /** Repo project path from the eval-hub summary (F248 Phase C fix). */
  projectPath?: string;
  /** Repo worktreeId from the eval-hub summary (F248 Phase C fix). */
  worktreeId?: string;
}) {
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const currentThreadProjectPath = useChatStore(
    (state) => state.threads.find((thread) => thread.id === state.currentThreadId)?.projectPath ?? 'default',
  );
  const setCurrentThread = useChatStore((state) => state.setCurrentThread);
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setWorkspaceOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const pathname = usePathname();
  const router = useRouter();
  const openWorkspaceFile = useCallback(
    (path: string) => {
      const shouldReturnToCurrentThread =
        currentThreadId &&
        currentThreadId !== 'default' &&
        currentThreadProjectPath &&
        currentThreadProjectPath === projectPath;
      const routeTarget = shouldReturnToCurrentThread ? `/thread/${encodeURIComponent(currentThreadId)}` : '/';
      if (pathname?.startsWith('/settings') && routeTarget === '/') {
        setCurrentThread('default');
      }
      if (projectPath) {
        setCurrentProject(projectPath);
      }
      setWorkspaceOpenFile(path, null, worktreeId ?? null);
      if (pathname?.startsWith('/settings')) {
        router.push(routeTarget);
      }
    },
    [
      currentThreadId,
      currentThreadProjectPath,
      pathname,
      projectPath,
      router,
      setCurrentThread,
      setCurrentProject,
      setWorkspaceOpenFile,
      worktreeId,
    ],
  );
  const openTrajectoryEvidence = useCallback(
    (invocationId: string) => {
      if (!currentThreadId) return;
      const element = findEvalWorkspaceEvent(item.id);
      const container = findTrajectoryOriginScrollContainer(element);
      const viewportOffsetPx =
        element && container ? element.getBoundingClientRect().top - container.getBoundingClientRect().top : 0;
      openInvocationTrajectory({
        invocationId,
        originRef: {
          kind: 'eval',
          threadId: currentThreadId,
          eventId: item.id,
          viewportOffsetPx,
        },
      });
      if (pathname?.startsWith('/settings') && typeof window !== 'undefined') {
        const query = new URL(window.location.href).searchParams.toString();
        router.push(`/thread/${encodeURIComponent(currentThreadId)}?${query}`);
      }
    },
    [currentThreadId, item.id, pathname, router],
  );

  return (
    <section className="rounded-lg bg-cafe-surface-elevated p-4" data-eval-event-id={item.id} tabIndex={-1}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium text-cafe-muted">
            {item.systemWorkspace.label} · {item.domainId}
          </div>
          <h3 className="mt-1 break-words text-base font-semibold text-cafe">{item.operatorNarrative.headline}</h3>
          <p className="mt-2 text-sm leading-relaxed text-cafe-secondary">{item.operatorNarrative.summary}</p>
        </div>
        <StatusBadge verdict={item.verdict} stale={item.lifecycle.stale} />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <InfoBlock label="现在要做" value={item.operatorNarrative.action} />
        <InfoBlock label="下次看什么" value={formatOperatorNextCheck(item)} />
      </div>

      <HubEvalLifecycleSummary lifecycle={item.lifecycle} openWorkspaceFile={openWorkspaceFile} />

      <details className="mt-4 rounded-md border border-cafe px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-cafe-secondary">机器原文与证据</summary>
        <div className="mt-3 space-y-3">
          <InfoBlock label="结论记录" value={item.id} />
          <InfoBlock label="现象原文" value={item.phenomenon} />
          <InfoBlock label="动作原文" value={item.ownerAsk} />
          <div className="grid gap-3 md:grid-cols-2">
            <InfoBlock
              label="评估目标"
              value={`${item.harnessUnderEval.featureId}/${item.harnessUnderEval.componentId}`}
            />
            <InfoBlock label="组件名称" value={item.harnessUnderEval.name} />
            <InfoBlock label="原始复评字段" value={formatRawReeval(item)} />
            <InfoBlock
              label="趋势窗口"
              value={`${item.trend.window.durationHours.toFixed(2)} 小时 · ${item.trend.components.length} 个组件`}
            />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-cafe-muted">证据引用</div>
            <EvidenceList
              refs={[
                ...item.evidence.snapshotRefs,
                ...item.evidence.attributionRefs,
                ...item.evidence.metricRefs,
                ...item.evidence.otherRefs,
              ]}
              metricGlossary={metricGlossary}
              onOpenInvocation={openTrajectoryEvidence}
            />
          </div>
        </div>
      </details>

      {item.domainId === 'eval:friction' && (
        <HubEvalFrictionSections friction={item.friction} openWorkspaceFile={openWorkspaceFile} />
      )}

      <div className="mt-4 space-y-2">
        <div className="text-xs font-medium text-cafe-muted">快捷导航</div>
        <div className="flex flex-wrap gap-2">
          <JumpButton onClick={() => openWorkspaceFile(item.source.verdictPath)}>结论文件</JumpButton>
          <JumpButton onClick={() => openWorkspaceFile(`${item.source.bundleDir}/snapshot.json`)}>快照包</JumpButton>
          <JumpButton onClick={() => openWorkspaceFile(`${item.source.bundleDir}/attribution.json`)}>归因包</JumpButton>
          <a
            href={`/thread/${encodeURIComponent(item.systemWorkspace.threadId)}`}
            className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
          >
            {item.systemWorkspace.label} 工作线程
          </a>
          <a
            href="/settings?ops=observability&obs=traces"
            className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
          >
            相关 Traces
          </a>
          {item.domainId === 'eval:memory' && (
            <a
              href="/memory/health"
              className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
            >
              记忆健康
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ verdict, stale }: { verdict: EvalHubItem['verdict']; stale: boolean }) {
  const key = stale ? 'stale' : verdict;
  return (
    <span className="inline-flex shrink-0 rounded-md bg-cafe-surface px-2.5 py-1 text-xs font-semibold text-[var(--console-button-emphasis)]">
      {VERDICT_LABELS[key]}
    </span>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-cafe-muted">{label}</div>
      <div className="mt-0.5 break-words text-sm text-cafe">{value}</div>
    </div>
  );
}

function EvidenceList({
  refs,
  metricGlossary,
  onOpenInvocation,
}: {
  refs: string[];
  metricGlossary?: EvalMetricGlossary;
  onOpenInvocation: (invocationId: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {refs.map((ref) => {
        const metric = resolveMetricGlossaryEntry(ref, metricGlossary);
        const invocationId = invocationIdFromEvidenceRef(ref);
        return (
          <li key={ref} className="break-all rounded-md bg-cafe-surface px-2 py-1 text-xs text-cafe-secondary">
            {invocationId ? (
              <button
                type="button"
                onClick={() => onOpenInvocation(invocationId)}
                className="font-semibold text-cafe-secondary underline underline-offset-2 hover:text-cafe-accent"
                data-testid="hub-trajectory-evidence"
                data-invocation-id={invocationId}
              >
                Invocation 轨迹 · {ref}
              </button>
            ) : metric ? (
              <div className="space-y-0.5">
                <div>
                  <span className="font-medium text-cafe">{metric.label}</span>{' '}
                  <span className="font-mono text-cafe-muted">{ref}</span>
                </div>
                <div>{metric.means}</div>
              </div>
            ) : (
              <span className="font-mono">{ref}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function resolveMetricGlossaryEntry(ref: string, glossary?: EvalMetricGlossary) {
  if (!glossary || !ref.startsWith('metric:')) return undefined;
  for (const candidate of metricRefKeyCandidates(ref)) {
    const entry = glossary[candidate];
    if (entry) return entry;
  }
  return undefined;
}

function JumpButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
    >
      {children}
    </button>
  );
}

function formatRawReeval(item: EvalHubItem): string {
  if (item.reeval.nextEvalAt) {
    return `${item.reeval.status} · ${formatEvalDate(item.reeval.nextEvalAt)}`;
  }
  return `${item.reeval.status} · ${item.reeval.summary}`;
}

function formatOperatorNextCheck(item: EvalHubItem): string {
  const nextEvalAt = currentEvalDueAt(item);
  if (!nextEvalAt) return item.operatorNarrative.nextCheck;
  const date = formatEvalDate(nextEvalAt);
  return `${item.operatorNarrative.nextCheck} 原计划：${date}。`;
}

function formatEvalDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
