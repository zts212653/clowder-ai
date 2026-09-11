'use client';

/**
 * Machine-local CLI availability for the currently selected client.
 *
 * Read-only by design: a member's `cli` block is server-derived from the descriptor registry,
 * so this card never offers to edit it. Its job is to answer the question the editor could not
 * answer before — "is the CLI this member needs actually installed here?" — and, when it is
 * not, to hand over the exact install command instead of letting the first task fail.
 *
 * Detection is user-triggered rather than fetched on mount, on purpose. A self-fetching child
 * fires its request before its parent's effects do (React runs effects bottom-up), which
 * silently reorders any caller that queues responses in call order — it broke
 * `hub-cat-editor.test.tsx` exactly that way. It also means merely opening the editor would
 * touch the filesystem. One explicit click keeps both the cost and the side effect in the
 * user's hands.
 *
 * Fails soft: a failed request renders a muted line, never an error state that blocks the form.
 */

import type { ProviderAvailability } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ClientsResponse {
  detectedAt?: string;
  ageMs?: number;
  providers?: ProviderAvailability[];
}

interface ProviderCliStatusProps {
  clientId: string;
}

type Phase = 'idle' | 'loading' | 'ready' | 'failed';

function StatusPill({ tone, children }: { tone: 'ok' | 'missing' | 'neutral'; children: ReactNode }) {
  const classes =
    tone === 'ok'
      ? 'bg-conn-green-bg text-conn-green-text'
      : tone === 'missing'
        ? 'bg-conn-amber-bg text-conn-amber-text'
        : 'text-cafe-muted';
  return <span className={`rounded-lg px-2 py-0.5 text-xs font-medium ${classes}`}>{children}</span>;
}

const ACTION_BUTTON_CLASS =
  'rounded-lg border border-[var(--console-border-soft)] px-2 py-0.5 text-xs text-cafe-muted transition hover:border-conn-amber-ring disabled:opacity-50';

export function ProviderCliStatus({ clientId }: ProviderCliStatusProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(null);

  const load = useCallback(async (options: { refresh?: boolean } = {}) => {
    setPhase('loading');
    try {
      const res = options.refresh
        ? await apiFetch('/api/clients/refresh', { method: 'POST' })
        : await apiFetch('/api/clients');
      if (!res.ok) throw new Error(`clients request failed (${res.status})`);
      const body = (await res.json()) as ClientsResponse;
      setProviders(Array.isArray(body.providers) ? body.providers : []);
      setPhase('ready');
    } catch {
      // Availability is advisory — an unreachable endpoint must not look like "not installed".
      setProviders(null);
      setPhase('failed');
    }
  }, []);

  if (phase === 'idle') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-3">
        <span className="text-xs font-semibold text-cafe-secondary">本机 CLI 状态</span>
        <button type="button" onClick={() => void load()} className={ACTION_BUTTON_CLASS}>
          检测本机 CLI
        </button>
        <span className="text-xs text-cafe-muted">确认这个成员需要的 CLI 是否已安装</span>
      </div>
    );
  }

  if (phase === 'failed') {
    return <p className="text-xs leading-5 text-cafe-muted">本机 CLI 状态不可用（/api/clients 请求失败）</p>;
  }

  if (phase === 'loading' || !providers) {
    return <p className="text-xs leading-5 text-cafe-muted">正在检测本机已安装的 CLI…</p>;
  }

  const current = providers.find((provider) => provider.clientId === clientId);
  const installed = providers.filter((provider) => provider.installed && provider.localCli);

  return (
    <div className="space-y-2 rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-cafe-secondary">本机 CLI 状态</span>
        <button
          type="button"
          onClick={() => void load({ refresh: true })}
          disabled={phase === 'loading'}
          className={ACTION_BUTTON_CLASS}
        >
          重新检测
        </button>
      </div>

      {current && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-cafe">{current.label}</span>
            {current.status === 'configured' && <StatusPill tone="ok">已安装</StatusPill>}
            {current.status === 'missing' && <StatusPill tone="missing">未安装</StatusPill>}
            {current.status === 'unsupported' && <StatusPill tone="neutral">无需本机 CLI</StatusPill>}
            {current.status === 'error' && <StatusPill tone="missing">配置有误</StatusPill>}
            {current.version && <span className="text-xs text-cafe-muted">{current.version}</span>}
          </div>
          {current.status === 'configured' && current.resolvedPath && (
            <p className="break-all text-xs leading-5 text-cafe-muted">路径：{current.resolvedPath}</p>
          )}
          {current.reason && <p className="text-xs leading-5 text-conn-amber-text">{current.reason}</p>}
          {(current.status === 'missing' || current.status === 'error') && (
            <p className="break-all text-xs leading-5 text-cafe-muted">安装命令：{current.installHint}</p>
          )}
        </div>
      )}

      <p className="text-xs leading-5 text-cafe-muted">
        {installed.length > 0
          ? `本机已安装：${installed.map((provider) => provider.label).join('、')}`
          : '本机未检测到任何本地 CLI。'}
      </p>
    </div>
  );
}
