'use client';

// biome-ignore lint/correctness/noUnusedImports: React must be in scope for SSR JSX runtime in tests.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ProviderProfilesResponse } from './hub-provider-profiles.types';
import { buildAccountQuotaPools } from './hub-quota-pools';
import { type CodexUsageItem, QuotaPoolRow, type QuotaResponse, riskDotClass, toUtilization } from './quota-cards';

export const POLL_INTERVAL_MS = 30_000;
export const QUOTA_ALERT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

// --- Risk logic (kept for notification dedup) ---

function maxUtilization(quota: QuotaResponse | null): number {
  if (!quota) return 0;
  let max = 0;
  for (const item of quota.codex.usageItems) max = Math.max(max, toUtilization(item));
  for (const item of quota.claude.usageItems ?? []) max = Math.max(max, toUtilization(item));
  for (const item of quota.gemini?.usageItems ?? []) max = Math.max(max, toUtilization(item));
  for (const item of quota.antigravity?.usageItems ?? []) max = Math.max(max, toUtilization(item));
  return max;
}

function resolveRisk(quota: QuotaResponse | null, refreshError: string | null): 'ok' | 'warn' | 'high' {
  if (refreshError || quota?.codex?.error || quota?.claude?.error || quota?.gemini?.error || quota?.antigravity?.error)
    return 'high';
  const max = maxUtilization(quota);
  if (max >= 95) return 'high';
  if (max >= 80) return 'warn';
  return 'ok';
}

export function shouldSendQuotaRiskNotification({
  currentRisk,
  previousRisk,
  lastAlertAt,
  nowMs,
  windowMs = QUOTA_ALERT_DEDUPE_WINDOW_MS,
}: {
  currentRisk: 'ok' | 'warn' | 'high';
  previousRisk: 'ok' | 'warn' | 'high';
  lastAlertAt: number;
  nowMs: number;
  windowMs?: number;
}): boolean {
  if (currentRisk !== 'high') return false;
  if (previousRisk !== 'high') return true;
  return nowMs - lastAlertAt >= windowMs;
}

// --- Component ---

export function HubQuotaBoardTab() {
  const { cats } = useCatData();
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [profiles, setProfiles] = useState<ProviderProfilesResponse['providers']>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const previousRiskRef = useRef<'ok' | 'warn' | 'high'>('ok');
  const lastAlertAtRef = useRef<number>(0);

  const riskLevel = resolveRisk(quota, refreshError);

  const fetchQuota = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quota');
      if (res.ok) setQuota((await res.json()) as QuotaResponse);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    fetchQuota();
    const id = setInterval(fetchQuota, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchQuota]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/provider-profiles')
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as ProviderProfilesResponse;
      })
      .then((body) => {
        if (!cancelled && body) setProfiles(body.providers);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // System notification on risk transition
  useEffect(() => {
    const prev = previousRiskRef.current;
    const now = Date.now();
    const shouldNotify = shouldSendQuotaRiskNotification({
      currentRisk: riskLevel,
      previousRisk: prev,
      lastAlertAt: lastAlertAtRef.current,
      nowMs: now,
    });
    previousRiskRef.current = riskLevel;
    if (!shouldNotify) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    void navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (!reg) return;
        lastAlertAtRef.current = now;
        return reg.showNotification('配额高风险预警', {
          body: '有额度池进入高风险，请检查配额看板。',
          tag: 'quota-alert',
        });
      })
      .catch(() => {});
  }, [riskLevel]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await apiFetch('/api/quota/refresh/official', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interactive: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setRefreshError(body.error ?? '获取官方额度失败');
      }
      await fetchQuota();
    } catch {
      setRefreshError('获取官方额度失败，请稍后重试');
    } finally {
      setRefreshing(false);
    }
  }, [fetchQuota]);

  const accountPools = buildAccountQuotaPools(quota, profiles, cats);
  const errors = [
    ...new Set(
      [refreshError, quota?.codex?.error, quota?.claude?.error, quota?.gemini?.error, quota?.antigravity?.error].filter(
        Boolean,
      ) as string[],
    ),
  ];

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">配额看板</h3>
        <div className="flex items-center gap-3">
          {quota?.fetchedAt && (
            <span className="text-xs text-gray-400">{new Date(quota.fetchedAt).toLocaleTimeString()}</span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-3 py-1 text-xs rounded-md bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {refreshing ? '刷新中...' : '刷新全部'}
          </button>
        </div>
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {accountPools.map((pool) => (
        <PoolSection
          key={pool.id}
          title={pool.title}
          items={pool.items}
          memberTags={pool.memberTags}
          emptyText={pool.emptyText}
        />
      ))}
    </section>
  );
}

function PoolSection({
  title,
  items,
  memberTags,
  emptyText,
}: {
  title: string;
  items: CodexUsageItem[];
  memberTags: string[];
  emptyText?: string;
}) {
  // Compute worst utilization for group header dot
  const worstUtil = items.length > 0 ? Math.max(...items.map(toUtilization)) : -1;
  const dotClass = worstUtil >= 0 ? riskDotClass(worstUtil) : 'text-gray-300';

  return (
    <div className="border-t border-gray-100 pt-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={`text-xs ${dotClass}`} aria-hidden="true">
          {'\u25CF'}
        </span>
        <span className="text-xs font-semibold tracking-wide text-gray-600">{title}</span>
        {memberTags.map((tag) => (
          <span key={tag} className="rounded-full bg-[#F3EDFA] px-2 py-0.5 text-[11px] font-medium text-[#8B68B7]">
            {tag}
          </span>
        ))}
      </div>
      {items.length > 0
        ? items.map((item) => <QuotaPoolRow key={item.label} item={item} />)
        : emptyText && <div className="ml-5 text-xs text-gray-400">{emptyText}</div>}
    </div>
  );
}
