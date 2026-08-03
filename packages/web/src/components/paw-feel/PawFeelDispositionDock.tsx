'use client';

import type { PawFeelDispositionState, PawFeelInboxPage } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const ACTIVE_STATES = new Set<PawFeelDispositionState>(['new', 'seen', 'route_pending']);

const STATE_LABELS: Record<PawFeelDispositionState, string> = {
  new: '等待审阅',
  seen: '已看',
  route_pending: '等待接单',
  routed: '已移交',
  closed: '已关闭',
  duplicate: '重复',
  no_action: '无需行动',
  fix: '已确认要修',
};

function isInboxPage(value: unknown): value is PawFeelInboxPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PawFeelInboxPage>;
  return (
    (candidate.projectionStatus === 'available' || candidate.projectionStatus === 'unavailable') &&
    Array.isArray(candidate.items) &&
    typeof candidate.degraded === 'boolean'
  );
}

function detailFor(item: PawFeelInboxPage['items'][number]): string | undefined {
  const { disposition } = item;
  if (disposition.state === 'routed') {
    return `已移交至 ${disposition.targetThreadId ?? disposition.proposalId ?? '责任面'}，不代表已经修复`;
  }
  if (disposition.state === 'route_pending') {
    return disposition.targetThreadId
      ? `等待 ${disposition.targetThreadId} 接单`
      : `等待 F128 proposal ${disposition.proposalId ?? ''} 获批`;
  }
  if (disposition.state === 'duplicate' && disposition.duplicateOf) {
    return `重复于 ${disposition.duplicateOf}`;
  }
  if (disposition.state === 'fix') {
    return `由 @${disposition.ownerCatId ?? 'unknown'} 负责 · 任务 ${disposition.taskId ?? 'unavailable'} · active lease ${
      disposition.actionLeaseRef?.leaseId ?? 'unavailable'
    }`;
  }
  if (disposition.reasonCode) return `理由：${disposition.reasonCode}`;
  return undefined;
}

export function PawFeelDispositionDock({ messageId, pollMs = 30_000 }: { messageId: string; pollMs?: number }) {
  const [page, setPage] = useState<PawFeelInboxPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/paw-feel/source/${encodeURIComponent(messageId)}`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const payload: unknown = await response.json();
      if (!isInboxPage(payload)) throw new Error('invalid response');
      setPage(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [messageId]);

  const terminal =
    page?.projectionStatus === 'available' &&
    page.items.length > 0 &&
    page.items.every((item) => !ACTIVE_STATES.has(item.disposition.state));

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollMs <= 0 || terminal) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [load, pollMs, terminal]);

  if (error) {
    return (
      <output className="mt-3 block border-t border-current/15 pt-2 text-micro opacity-70">
        爪感差处置状态暂不可读；原报告仍已保留。
      </output>
    );
  }
  if (!page) return null;
  if (page.projectionStatus === 'unavailable') {
    return (
      <output className="mt-3 block border-t border-current/15 pt-2 text-micro opacity-70">
        处置台账暂不可用；原报告仍已保留。
      </output>
    );
  }
  if (page.items.length === 0) return null;
  const stateCounts = new Map<PawFeelDispositionState, number>();
  for (const item of page.items) {
    const state = item.disposition.state;
    stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
  }
  const latestDisposition = [...page.items]
    .sort((left, right) => left.disposition.lastTransitionAt.localeCompare(right.disposition.lastTransitionAt))
    .at(-1)?.disposition;
  const latestActor = latestDisposition?.ownerCatId ?? latestDisposition?.lastActorCatId;

  return (
    <section
      className="mt-3 space-y-1.5 border-t border-current/15 pt-2"
      aria-label="爪感差处置状态"
      data-testid="paw-feel-disposition-dock"
    >
      <div className="text-micro font-semibold opacity-75">责任收件箱 · {page.items.length} 条报告</div>
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-micro opacity-70">
        {[...stateCounts].map(([state, count]) => (
          <span key={state}>
            {STATE_LABELS[state]} {count}
          </span>
        ))}
        {latestActor ? <span>最近审阅 @{latestActor}</span> : null}
      </div>
      <details
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        className="rounded-md border border-current/15 px-2 py-1.5 text-xs"
      >
        <summary className="cursor-pointer">展开逐条处置证据</summary>
        {expanded ? (
          <div className="mt-2 space-y-1.5">
            {page.items.map((item) => {
              const detail = detailFor(item);
              return (
                <div
                  key={item.disposition.signalId}
                  className="rounded-md border border-current/15 px-2 py-1.5"
                  data-state={item.disposition.state}
                  data-testid="paw-feel-disposition-detail"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{STATE_LABELS[item.disposition.state]}</span>
                    {(item.disposition.ownerCatId ?? item.disposition.lastActorCatId) ? (
                      <span className="opacity-65">
                        · @{item.disposition.ownerCatId ?? item.disposition.lastActorCatId}
                      </span>
                    ) : null}
                    {item.overdue ? (
                      <span className="rounded-full border border-current px-1 py-0.5 text-micro font-semibold">
                        72h+
                      </span>
                    ) : null}
                  </div>
                  {detail ? <p className="mt-1 text-micro leading-relaxed opacity-70">{detail}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </details>
    </section>
  );
}
