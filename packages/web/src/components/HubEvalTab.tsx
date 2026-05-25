'use client';

import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

interface EvalHubSummary {
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
  };
  items: EvalHubItem[];
}

interface EvalHubItem {
  id: string;
  domainId: string;
  packetId: string;
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  phenomenon: string;
  ownerAsk: string;
  harnessUnderEval: {
    featureId: string;
    componentId: string;
    name: string;
  };
  reeval: {
    nextEvalAt?: string;
    status: 'observing' | 'pending_owner' | 'pending_reeval';
    summary: string;
  };
  lifecycle: {
    ownerResponseStatus: 'not_required' | 'not_started';
    closureStatus: 'observing' | 'open';
    stale: boolean;
  };
  evidence: {
    snapshotRefs: string[];
    attributionRefs: string[];
    metricRefs: string[];
    otherRefs: string[];
  };
  trend: {
    generatedAt: string;
    window: { durationHours: number };
    components: Array<{
      componentId: string;
      componentName: string;
      confidence: string;
      activationCounts: Record<string, number | null>;
      frictionCounts: Record<string, number | null>;
    }>;
  };
  systemWorkspace: {
    kind: 'eval_domain';
    id: string;
    label: string;
    threadId: string;
    stateSot: 'registry';
  };
  source: {
    verdictPath: string;
    bundleDir: string;
  };
}

export function HubEvalTab() {
  const [summary, setSummary] = useState<EvalHubSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      setError(null);
      const response = await apiFetch('/api/eval-hub/summary');
      if (!response.ok) {
        throw new Error(`Eval Hub summary failed (${response.status})`);
      }
      setSummary((await response.json()) as EvalHubSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  if (loading) return <p className="text-sm text-cafe-muted">...</p>;
  if (error) {
    return (
      <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-conn-red-text" role="alert">
        Eval Hub 暂时不可用：{error}
      </div>
    );
  }
  if (!summary || summary.items.length === 0) {
    return (
      <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-cafe-secondary">
        还没有 live verdict。Eval Hub 只展示已经提交证据包的真实 eval 结论。
      </div>
    );
  }

  return (
    <div className="space-y-4" data-guide-id="observability.eval-panel">
      <p className="text-xs text-cafe-muted">
        Harness Eval 控制面板：猫猫定期评估自身协作机制的健康度，下方是最新评估结论。
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCell label="评估结论" sublabel="总数" value={summary.counts.total} />
        <StatCell label="需处理" sublabel="build/fix/delete" value={summary.counts.actionable} />
        <StatCell label="持续观察" sublabel="暂无异常" value={summary.counts.keepObserve} />
        <StatCell label="过期" sublabel="需重新评估" value={summary.counts.stale} />
      </div>

      <div className="space-y-3">
        {summary.items.map((item) => (
          <EvalVerdictCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function StatCell({ label, sublabel, value }: { label: string; sublabel?: string; value: number }) {
  return (
    <div className="rounded-lg bg-cafe-surface-elevated px-4 py-3">
      <div className="text-xs text-cafe-muted">{label}</div>
      {sublabel && <div className="text-micro text-cafe-muted/60">{sublabel}</div>}
      <div className="mt-1 text-xl font-semibold text-cafe">{value}</div>
    </div>
  );
}

function EvalVerdictCard({ item }: { item: EvalHubItem }) {
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

const VERDICT_LABELS: Record<EvalHubItem['verdict'] | 'stale', string> = {
  keep_observe: '持续观察',
  fix: '需修复',
  build: '需新建',
  delete_sunset: '可下线',
  stale: '已过期',
};

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
