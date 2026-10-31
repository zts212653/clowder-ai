'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ThreadNativeStatusV1 } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export function ThreadNativeStatusSettingsContent({ threadId }: { threadId: string }) {
  const [statuses, setStatuses] = useState<ThreadNativeStatusV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/threads/${threadId}/native-status`);
      if (!response.ok) throw new Error('native_status_failed');
      const body = (await response.json()) as { statuses: ThreadNativeStatusV1[] };
      setStatuses(body.statuses);
    } catch {
      setError('Codex 运行状态当前无法读取；不会用本地配置猜测。');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-micro text-cafe-muted">只展示实时读取结果；读取失败时不会伪造 provider 观测。</p>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="text-micro text-cafe-accent">
          {loading ? '读取中…' : '刷新'}
        </button>
      </div>
      {error && (
        <p className="rounded-lg border border-conn-red-ring bg-conn-red-bg px-2.5 py-2 text-micro text-conn-red-text">
          {error}
        </p>
      )}
      {!loading && !error && statuses.length === 0 && (
        <p className="text-micro text-cafe-muted">没有可读取的 Codex 原生会话绑定；先在这条对话中运行一次 Codex。</p>
      )}
      {statuses.map((status) => (
        <StatusCard key={`${status.catId}:${status.runtimeSessionId}`} status={status} />
      ))}
    </div>
  );
}

function StatusCard({ status }: { status: ThreadNativeStatusV1 }) {
  if (status.observation === 'unavailable') {
    return (
      <article className="rounded-xl border border-conn-red-ring bg-conn-red-bg px-3 py-2.5 text-micro text-conn-red-text">
        <p className="font-semibold">{status.catId}</p>
        <p className="mt-1">本次未取得 Codex app-server 状态；没有可声明的来源时间。</p>
      </article>
    );
  }
  const rows = statusRows(status);
  return (
    <article className="rounded-xl border border-cafe-subtle bg-cafe-bg px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-xs font-semibold text-cafe-black">{status.catId}</span>
        <span className="text-micro text-cafe-muted">{freshnessLabel(status.observedAt)}</span>
      </div>
      <p className="mt-0.5 text-micro text-cafe-muted">来源：Codex app-server 实时读取</p>
      <dl className="mt-2 grid gap-1 text-micro text-cafe-secondary">
        {rows.map(([label, value]) => (
          <StatusRow key={label} label={label} value={value} />
        ))}
      </dl>
    </article>
  );
}

type AvailableStatus = Extract<ThreadNativeStatusV1, { observation: 'available' }>;

function statusRows(status: AvailableStatus): Array<[string, string]> {
  return [
    ['会话', threadStatusLabel(status)],
    ['能力', capabilityStatusLabel(status)],
    ['权限', permissionStatusLabel(status)],
    ['账户', accountStatusLabel(status)],
    ['额度', rateLimitStatusLabel(status)],
    ['原生 thread 诊断', threadListStatusLabel(status)],
  ];
}

function threadStatusLabel(status: AvailableStatus): string {
  if (status.thread.availability !== 'available') return '当前不可用';
  return `${status.thread.status}${status.thread.canAcceptDirectInput ? ' · 可接收输入' : ''}`;
}

function capabilityStatusLabel(status: AvailableStatus): string {
  if (status.capabilities.availability !== 'available') return '当前不可用';
  const names = [
    status.capabilities.webSearch ? 'web search' : null,
    status.capabilities.imageGeneration ? 'image generation' : null,
    status.capabilities.namespaceTools ? 'namespace tools' : null,
  ].filter(Boolean);
  return names.join(' · ') || '未声明可用能力';
}

function permissionStatusLabel(status: AvailableStatus): string {
  return status.permissionProfiles.availability === 'available'
    ? (status.permissionProfiles.activeId ?? '未报告 active profile')
    : '当前不可用';
}

function accountStatusLabel(status: AvailableStatus): string {
  if (status.account.availability !== 'available') return '当前不可用';
  if (!status.account.authenticated) return '未登录';
  return [status.account.kind, status.account.plan].filter(Boolean).join(' · ');
}

function rateLimitStatusLabel(status: AvailableStatus): string {
  if (status.rateLimits.availability !== 'available') return '当前不可用';
  return status.rateLimits.primary ? `${status.rateLimits.primary.usedPercent}% 已用` : '未报告窗口';
}

function threadListStatusLabel(status: AvailableStatus): string {
  if (status.nativeThreadList.availability !== 'available') return '当前不可用';
  return `${status.nativeThreadList.count}${status.nativeThreadList.boundThreadPresent ? ' · 当前绑定可见' : ''}`;
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 flex-shrink-0 text-cafe-muted">{label}：</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

function freshnessLabel(observedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - observedAt) / 1_000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  return new Date(observedAt).toLocaleString();
}
