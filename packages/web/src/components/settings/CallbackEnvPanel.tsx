'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface EnvSummaryResponse {
  variables: EnvVar[];
}

export function CallbackEnvPanel() {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/config/env-summary');
        if (cancelled) return;
        if (!res.ok) {
          setError('加载失败');
          return;
        }
        const data = (await res.json()) as EnvSummaryResponse;
        setVars(data.variables.filter((v) => v.name.startsWith('CAT_CAFE_CALLBACK_')));
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="console-status-chip" data-status="error">
        {error}
      </div>
    );
  }
  if (vars.length === 0) return null;

  return (
    <section className="console-section-shell rounded-xl p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">MCP Callback</p>
          <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">Callback 环境变量</h3>
          <p className="max-w-3xl text-sm leading-6 text-cafe-secondary">
            回调鉴权和 outbox 投递相关配置（其中 TOKEN 注入 MCP 子进程，OUTBOX_* 为宿主进程参数）
          </p>
        </div>
        <span className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold text-cafe-secondary">
          {vars.length} vars
        </span>
      </div>
      <div className="mt-4 rounded-xl bg-[var(--console-card-bg)] px-4">
        {vars.map((v) => {
          const displayValue = v.sensitive ? '***' : (v.currentValue ?? v.defaultValue) || '未设置';
          const scopeLabel = v.name === 'CAT_CAFE_CALLBACK_TOKEN' ? '子进程 + 宿主' : '宿主进程';
          return (
            <div
              key={v.name}
              className="flex items-start justify-between gap-3 border-b border-[var(--console-border-soft)] py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-cafe">{v.name}</span>
                  <span className="console-status-chip" data-status={v.sensitive ? 'warning' : 'info'}>
                    {v.sensitive ? '敏感' : '可见'}
                  </span>
                  <span className="console-pill inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-cafe-secondary">
                    {scopeLabel}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-cafe-secondary">{v.description}</p>
              </div>
              <span className="shrink-0 break-all font-mono text-xs text-cafe-secondary">{displayValue}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
