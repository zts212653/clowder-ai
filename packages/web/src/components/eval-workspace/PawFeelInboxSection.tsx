'use client';

import type { PawFeelDispositionState, PawFeelInboxPage, PawFeelInboxSort } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { PawFeelDutyBanner, PawFeelInboxBody, PawFeelInboxHeader, PawFeelInboxNotices } from './PawFeelInboxChrome';
import { type PawFeelFilter, PawFeelInboxToolbar } from './PawFeelInboxToolbar';
import { usePawFeelDuty } from './usePawFeelDuty';

const FILTER_STATES: Record<PawFeelFilter, PawFeelDispositionState[] | undefined> = {
  active: ['new', 'seen', 'route_pending', 'routed', 'fix', 'signature_waiting', 'blocked'],
  all: undefined,
  overdue: ['new', 'seen', 'route_pending', 'routed', 'fix', 'signature_waiting', 'blocked'],
  disposed: ['closed', 'duplicate', 'no_action'],
};

function isInboxPage(value: unknown): value is PawFeelInboxPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PawFeelInboxPage>;
  return (
    (candidate.projectionStatus === 'available' || candidate.projectionStatus === 'unavailable') &&
    Array.isArray(candidate.items) &&
    Array.isArray(candidate.bundles) &&
    typeof candidate.bundleCounts === 'object' &&
    typeof candidate.denominator === 'object' &&
    typeof candidate.counts === 'object' &&
    typeof candidate.degraded === 'boolean'
  );
}

function queryFor(filter: PawFeelFilter, sort: PawFeelInboxSort, cursor?: string): string {
  const query = new URLSearchParams({ limit: '50', sort });
  const states = FILTER_STATES[filter];
  if (states) query.set('states', states.join(','));
  if (filter === 'overdue') query.set('overdueOnly', 'true');
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}

async function requestInboxPage(
  filter: PawFeelFilter,
  sort: PawFeelInboxSort,
  cursor?: string,
): Promise<PawFeelInboxPage> {
  const response = await apiFetch(`/api/paw-feel/inbox?${queryFor(filter, sort, cursor)}`);
  if (!response.ok) throw new Error(`爪感差收件箱请求失败 (${response.status})`);
  const payload: unknown = await response.json();
  if (!isInboxPage(payload)) throw new Error('爪感差收件箱返回了无效数据');
  return payload;
}

function appendInboxPage(previous: PawFeelInboxPage | null, payload: PawFeelInboxPage): PawFeelInboxPage {
  if (!previous) return payload;
  const existing = new Set(previous.items.map((item) => item.disposition.signalId));
  const existingBundles = new Set(previous.bundles.map((bundle) => bundle.bundleKey));
  return {
    ...payload,
    items: [...previous.items, ...payload.items.filter((item) => !existing.has(item.disposition.signalId))],
    bundles: [...previous.bundles, ...payload.bundles.filter((bundle) => !existingBundles.has(bundle.bundleKey))],
  };
}

function preserveExpandedRows(previous: PawFeelInboxPage | null, payload: PawFeelInboxPage): PawFeelInboxPage {
  if (!previous) return payload;
  return {
    ...payload,
    items: previous.items,
    bundles: previous.bundles,
    nextCursor: previous.nextCursor,
  };
}

function isActiveNewest(filter: PawFeelFilter, sort: PawFeelInboxSort): boolean {
  return filter === 'active' && sort === 'newest';
}

export function PawFeelInboxSection({
  variant = 'workspace',
  pollMs = 30_000,
}: {
  variant?: 'workspace' | 'history';
  pollMs?: number;
}) {
  const [page, setPage] = useState<PawFeelInboxPage | null>(null);
  const [filter, setFilter] = useState<PawFeelFilter>(variant === 'history' ? 'all' : 'active');
  const [sort, setSort] = useState<PawFeelInboxSort>(variant === 'history' ? 'oldest' : 'newest');
  const [newCount, setNewCount] = useState(0);
  const knownTotalRef = useRef<number | null>(null);
  const hasLoadedMoreRef = useRef(false);
  const duty = usePawFeelDuty(variant);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptFirstPage = useCallback((payload: PawFeelInboxPage, background: boolean) => {
    const knownTotal = knownTotalRef.current;
    if (knownTotal !== null && payload.bundleCounts.total > knownTotal) {
      setNewCount((current) => current + payload.bundleCounts.total - knownTotal);
    }
    knownTotalRef.current = Math.max(knownTotal ?? 0, payload.bundleCounts.total);
    const preserveRows = background && hasLoadedMoreRef.current;
    setPage((previous) => (preserveRows ? preserveExpandedRows(previous, payload) : payload));
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string, background = false) => {
      if (cursor) setLoadingMore(true);
      else if (!background) setLoading(true);
      try {
        setError(null);
        const payload = await requestInboxPage(filter, sort, cursor);
        if (cursor) {
          setPage((previous) => appendInboxPage(previous, payload));
          hasLoadedMoreRef.current = true;
        } else {
          acceptFirstPage(payload, background);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [acceptFirstPage, filter, sort],
  );

  useEffect(() => {
    hasLoadedMoreRef.current = false;
    void fetchPage();
    if (pollMs <= 0) return;
    const timer = window.setInterval(() => void fetchPage(undefined, true), pollMs);
    return () => window.clearInterval(timer);
  }, [fetchPage, pollMs]);

  const title = variant === 'history' ? '爪感差处置台账' : '爪感差责任收件箱';
  return (
    <section
      className="mt-4 rounded-xl border border-cafe bg-cafe-surface-elevated p-3 sm:p-4"
      aria-label={title}
      data-testid="paw-feel-inbox-section"
    >
      <PawFeelInboxHeader title={title} page={page} />
      <PawFeelDutyBanner variant={variant} duty={duty} page={page} />
      <PawFeelInboxToolbar
        page={page}
        filter={filter}
        sort={sort}
        newCount={newCount}
        dutyConfigured={duty.status === 'assigned'}
        onFilter={(nextFilter) => {
          setFilter(nextFilter);
          if (isActiveNewest(nextFilter, sort)) setNewCount(0);
        }}
        onSort={(nextSort) => {
          setSort(nextSort);
          if (isActiveNewest(filter, nextSort)) setNewCount(0);
        }}
        onNewest={() => {
          const needsExplicitRefresh = isActiveNewest(filter, sort);
          hasLoadedMoreRef.current = false;
          setFilter('active');
          setSort('newest');
          setNewCount(0);
          if (needsExplicitRefresh) void fetchPage();
        }}
      />
      <PawFeelInboxNotices page={page} error={error} />
      <PawFeelInboxBody
        page={page}
        loading={loading}
        loadingMore={loadingMore}
        onLoadMore={() => {
          if (page?.nextCursor) void fetchPage(page.nextCursor);
        }}
      />
    </section>
  );
}
