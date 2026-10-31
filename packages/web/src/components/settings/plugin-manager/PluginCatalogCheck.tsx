import { type ReactNode, useEffect, useState } from 'react';
import type { PluginCatalogCheckState } from './usePluginCatalogCheck';

function CatalogNotice({
  kind,
  message,
  onRetry,
  children,
}: {
  kind: 'degraded' | 'unavailable';
  message?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-inline-notice
      data-catalog-notice={kind}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-lg border border-cafe-border bg-[var(--shell-work)] px-2.5 py-2 text-[13px] text-cafe-secondary"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current text-conn-amber-text" />
        <div className="min-w-0 space-y-1">{children}</div>
      </div>
      <button type="button" className="console-button-secondary !h-7 !px-2 text-xs" onClick={onRetry}>
        再试一次
      </button>
      {message && (
        <details className="col-span-2 min-w-0 text-xs text-cafe-muted">
          <summary className="cursor-pointer">技术详情 ›</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{message}</p>
        </details>
      )}
    </div>
  );
}

export function PluginCatalogCheck({
  state,
  status,
  updates,
  onCheck,
  hasCachedEntries = false,
}: {
  state?: PluginCatalogCheckState;
  status: string;
  updates: number;
  onCheck?: () => void;
  hasCachedEntries?: boolean;
}) {
  const incomplete =
    state?.incomplete || status === 'degraded' || status === 'stale' || (state?.failedSources ?? 0) > 0;
  const observedAt = incomplete ? state?.checkedAt : state?.lastSuccessfulAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (observedAt == null) return;
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clock);
  }, [observedAt]);
  const age = observedAt == null ? null : Math.max(0, Math.floor((now - observedAt) / 60_000));
  const recent = age !== null && age < 1;
  if (state?.checking)
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-cafe-muted">
        <span
          aria-hidden="true"
          className="h-3 w-3 animate-spin rounded-full border border-cafe-border border-t-current"
        />
        正在检查插件目录…
      </p>
    );
  if (state?.unavailable || status === 'unavailable')
    return (
      <CatalogNotice kind="unavailable" message={state?.message} onRetry={onCheck}>
        <p>
          插件目录读不到
          {state?.lastSuccessfulAt
            ? `，下面是 ${new Date(state.lastSuccessfulAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 读到的`
            : hasCachedEntries
              ? '，保留上次读到的列表'
              : '，暂时看不到可以安装的插件'}
          。
        </p>
        <p>已装的插件照常可以开关、修复、卸载；安装和更新要等目录读到</p>
      </CatalogNotice>
    );
  if (incomplete)
    return (
      <CatalogNotice kind="degraded" message={state?.message} onRetry={onCheck}>
        <p>
          {state?.failedSources
            ? `${recent ? '刚查过，但' : age !== null ? `${age} 分钟前查过，但` : ''}有 ${state.failedSources} 个插件仓没读到，那里的新版可能还没显示`
            : '插件目录没有完整读到，新版可能还没显示'}
        </p>
      </CatalogNotice>
    );
  return (
    <p role="status" className="text-xs leading-5 text-cafe-muted">
      {state?.checked && recent
        ? `刚查过 · ${updates ? `${updates} 个有新版，放进了『需要处理』` : '都是最新的'}`
        : `插件目录${age !== null ? ` ${age} 分钟前查过` : ''}`}
      <span aria-hidden="true"> · </span>
      <button type="button" className="text-cafe-accent" onClick={onCheck}>
        检查更新
      </button>
    </p>
  );
}
