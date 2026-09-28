'use client';

import type { PawFeelInboxPage, PawFeelResponsibilityState } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { pawFeelDutyDetail } from './paw-feel-duty-presentation';
import { pawFeelIssueDetail, pawFeelIssueStatus } from './paw-feel-issue-presentation';
import { isPawFeelInboxPage } from './paw-feel-page-guard';

const STATE_LABELS: Record<PawFeelResponsibilityState, string> = {
  unreviewed: 'unreviewed',
  bound_in_repair: 'bound-in-repair',
  signature_waiting: 'signature-waiting',
  blocked: 'blocked',
  terminal: 'terminal',
};

function PawFeelDispositionDetail({ item }: { item: PawFeelInboxPage['items'][number] }) {
  const detail = pawFeelDutyDetail(item);
  const issueDetail = pawFeelIssueDetail(item);
  const actor = item.disposition.ownerCatId ?? item.disposition.lastActorCatId;
  return (
    <div
      className="rounded-md border border-current/15 px-2 py-1.5"
      data-state={item.responsibility.state}
      data-valid-exit={item.responsibility.validExit ? 'true' : 'false'}
      data-disposition-state={item.disposition.state}
      data-resolution={item.issue.resolution}
      data-continuation={item.issue.continuation.kind}
      data-testid="paw-feel-disposition-detail"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">{STATE_LABELS[item.responsibility.state]}</span>
        {actor ? <span className="opacity-65">· @{actor}</span> : null}
        {item.overdue ? (
          <span className="rounded-full border border-current px-1 py-0.5 text-micro font-semibold">72h+</span>
        ) : null}
      </div>
      <p className="mt-1 text-micro font-semibold leading-relaxed">{pawFeelIssueStatus(item)}</p>
      {issueDetail ? <p className="mt-1 text-micro leading-relaxed opacity-70">{issueDetail}</p> : null}
      {detail ? <p className="mt-1 text-micro leading-relaxed opacity-70">{detail}</p> : null}
    </div>
  );
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
      if (!isPawFeelInboxPage(payload)) throw new Error('invalid response');
      setPage(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [messageId]);

  const allIssuesResolved =
    page?.projectionStatus === 'available' &&
    page.items.length > 0 &&
    page.items.every((item) => item.issue.resolution === 'resolved');

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
    if (!inViewport || pollMs <= 0 || allIssuesResolved) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [allIssuesResolved, inViewport, load, pollMs]);

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
  const latestItem = [...page.items]
    .sort((left, right) => left.disposition.lastTransitionAt.localeCompare(right.disposition.lastTransitionAt))
    .at(-1);
  const latestDisposition = latestItem?.disposition;
  const latestActor = latestDisposition?.ownerCatId ?? latestDisposition?.lastActorCatId;
  const openIssueCount = page.items.filter((item) => item.issue.resolution === 'open').length;

  return (
    <div ref={anchorRef} data-paw-feel-viewport-anchor>
      <section
        className="mt-3 space-y-1.5 border-t border-current/15 pt-2"
        aria-label="爪感差处置状态"
        data-testid="paw-feel-disposition-dock"
      >
        <div className="text-micro font-semibold opacity-75">责任收件箱 · {page.items.length} 条报告</div>
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-micro opacity-70">
          <span>问题开放 {openIssueCount}</span>
          <span>问题解决 {page.items.length - openIssueCount}</span>
          {[...stateCounts].map(([state, count]) => (
            <span key={state}>
              {STATE_LABELS[state]} {count}
            </span>
          ))}
          {latestActor ? <span>最近审阅 @{latestActor}</span> : null}
        </div>
        {latestItem ? (
          <div className="text-micro font-semibold opacity-75">{pawFeelIssueStatus(latestItem)}</div>
        ) : null}
        <details
          onToggle={(event) => setExpanded(event.currentTarget.open)}
          className="rounded-md border border-current/15 px-2 py-1.5 text-xs"
        >
          <summary className="cursor-pointer">展开逐条处置证据</summary>
          {expanded ? (
            <div className="mt-2 space-y-1.5">
              {page.items.map((item) => (
                <PawFeelDispositionDetail key={item.disposition.signalId} item={item} />
              ))}
            </div>
          ) : null}
        </details>
      </section>
    </div>
  );
}
