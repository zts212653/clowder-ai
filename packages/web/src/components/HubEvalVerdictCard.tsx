'use client';

import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { HubEvalFrictionSections } from './HubEvalFrictionSections';
import { type EvalHubItem, VERDICT_LABELS } from './HubEvalTypes';

export function HubEvalVerdictCard({ item }: { item: EvalHubItem }) {
  const setWorkspaceOpenFile = useChatStore((state) => state.setWorkspaceOpenFile);
  const openWorkspaceFile = useCallback(
    (path: string) => {
      setWorkspaceOpenFile(path, null, null);
    },
    [setWorkspaceOpenFile],
  );

  return (
    <section className="rounded-lg bg-cafe-surface-elevated p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-cafe-muted">{item.domainId}</div>
          <h3 className="mt-1 break-words text-base font-semibold text-cafe">{item.id}</h3>
          <p className="mt-2 text-sm text-cafe-secondary">{item.phenomenon}</p>
        </div>
        <StatusBadge verdict={item.verdict} stale={item.lifecycle.stale} />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <InfoBlock label="评估目标" value={`${item.harnessUnderEval.featureId}/${item.harnessUnderEval.componentId}`} />
        <InfoBlock label="组件名称" value={item.harnessUnderEval.name} />
        <InfoBlock label="需要的动作" value={item.ownerAsk} />
        <InfoBlock label="下次评估" value={formatReeval(item)} />
        <InfoBlock label="工作域" value={item.systemWorkspace.label} />
        <InfoBlock
          label="趋势窗口"
          value={`${item.trend.window.durationHours.toFixed(2)} 小时 · ${item.trend.components.length} 个组件`}
        />
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-xs font-medium text-cafe-muted">证据引用</div>
        <EvidenceList
          refs={[...item.evidence.snapshotRefs, ...item.evidence.attributionRefs, ...item.evidence.metricRefs]}
        />
      </div>

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

function EvidenceList({ refs }: { refs: string[] }) {
  return (
    <ul className="space-y-1">
      {refs.map((ref) => (
        <li key={ref} className="break-all rounded-md bg-cafe-surface px-2 py-1 font-mono text-xs text-cafe-secondary">
          {ref}
        </li>
      ))}
    </ul>
  );
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

function formatReeval(item: EvalHubItem): string {
  if (item.reeval.nextEvalAt) {
    return `${item.reeval.status} · ${new Date(item.reeval.nextEvalAt).toLocaleString()}`;
  }
  return `${item.reeval.status} · ${item.reeval.summary}`;
}
