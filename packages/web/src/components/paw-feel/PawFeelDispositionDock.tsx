'use client';

import type { PawFeelInboxPage, PawFeelResponsibilityState } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const STATE_LABELS: Record<PawFeelResponsibilityState, string> = {
  unreviewed: 'unreviewed',
  bound_in_repair: 'bound-in-repair',
  signature_waiting: 'signature-waiting',
  blocked: 'blocked',
  terminal: 'terminal',
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
  if (item.responsibility.exitKind === 'signature_request') {
    return `等待独立签署；排除报告猫 @${item.responsibility.signerExclusionCatId ?? 'unknown'} 自签`;
  }
  if (item.responsibility.exitKind === 'explicit_blocker') {
    return `阻塞 ${item.responsibility.blocker?.code ?? 'unknown'} · ${item.responsibility.blocker?.ref ?? ''}`;
  }
  if (disposition.state === 'routed') {
    return `已移交至 ${disposition.targetThreadId ?? disposition.proposalId ?? '责任面'}，不代表已经修复`;
  }
  if (disposition.state === 'route_pending') {
    return disposition.targetThreadId
      ? `等待 ${disposition.targetThreadId} 接单`
      : `F128 proposal ${disposition.proposalId ?? 'unavailable'} 当前不是 pending，需重新路由或显式阻塞`;
  }
  if (disposition.state === 'duplicate' && disposition.duplicateOf) {
    return `重复于 ${disposition.duplicateOf}`;
  }
  if (disposition.state === 'fix') {
    const binding = `由 @${disposition.ownerCatId ?? 'unknown'} 负责 · 任务 ${
      disposition.taskId ?? 'unavailable'
    } · active lease ${disposition.actionLeaseRef?.leaseId ?? 'unavailable'}`;
    return item.responsibility.validExit ? binding : `${binding} · 当前 active lease 复验失败`;
  }
  if (disposition.reasonCode) return `理由：${disposition.reasonCode}`;
  return undefined;
}

export function PawFeelDispositionDock({ messageId, pollMs = 30_000 }: { messageId: string; pollMs?: number }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const visibleMessageIdRef = useRef<string | null>(null);
  const [page, setPage] = useState<PawFeelInboxPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [inViewport, setInViewport] = useState(false);

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

  const allResponsibilitiesHaveValidExit =
    page?.projectionStatus === 'available' &&
    page.items.length > 0 &&
    page.items.every((item) => item.responsibility.validExit);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof IntersectionObserver === 'undefined') {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setInViewport(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '600px 0px' },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inViewport) {
      visibleMessageIdRef.current = null;
      return;
    }
    if (visibleMessageIdRef.current === messageId) return;
    visibleMessageIdRef.current = messageId;
    void load();
  }, [inViewport, load, messageId]);

  useEffect(() => {
    if (!inViewport || pollMs <= 0 || allResponsibilitiesHaveValidExit) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [allResponsibilitiesHaveValidExit, inViewport, load, pollMs]);

  if (error) {
    return (
      <div ref={anchorRef} data-paw-feel-viewport-anchor>
        <output className="mt-3 block border-t border-current/15 pt-2 text-micro opacity-70">
          爪感差处置状态暂不可读；原报告仍已保留。
        </output>
      </div>
    );
  }
  if (!page) return <div ref={anchorRef} data-paw-feel-viewport-anchor className="h-px" />;
  if (page.projectionStatus === 'unavailable') {
    return (
      <div ref={anchorRef} data-paw-feel-viewport-anchor>
        <output className="mt-3 block border-t border-current/15 pt-2 text-micro opacity-70">
          处置台账暂不可用；原报告仍已保留。
        </output>
      </div>
    );
  }
  if (page.items.length === 0) return <div ref={anchorRef} data-paw-feel-viewport-anchor className="h-px" />;
  const stateCounts = new Map<PawFeelResponsibilityState, number>();
  for (const item of page.items) {
    const state = item.responsibility.state;
    stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
  }
  const latestDisposition = [...page.items]
    .sort((left, right) => left.disposition.lastTransitionAt.localeCompare(right.disposition.lastTransitionAt))
    .at(-1)?.disposition;
  const latestActor = latestDisposition?.ownerCatId ?? latestDisposition?.lastActorCatId;

  return (
    <div ref={anchorRef} data-paw-feel-viewport-anchor>
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
                    data-state={item.responsibility.state}
                    data-valid-exit={item.responsibility.validExit ? 'true' : 'false'}
                    data-disposition-state={item.disposition.state}
                    data-testid="paw-feel-disposition-detail"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold">{STATE_LABELS[item.responsibility.state]}</span>
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
    </div>
  );
}
