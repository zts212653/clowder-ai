'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface StepSummaryData {
  traceId: string;
  routeSpanId?: string;
  agent_loop_count: number | null;
  tool_call_count: number | null;
  a2a_dispatch_count: number | null;
  duration_ms: number;
  token_total: number;
  error_count: number;
  is_restored: boolean;
  width_avg_tools_per_loop: number | null;
  agent_loop_partial: boolean;
}

export function StepSummaryPanel({ traceId, routeSpanId }: { traceId: string; routeSpanId?: string }) {
  const [data, setData] = useState<StepSummaryData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    const query = new URLSearchParams({ traceId });
    if (routeSpanId) query.set('routeSpanId', routeSpanId);
    apiFetch(`/api/telemetry/step-summary?${query.toString()}`)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setData(null);
          return;
        }
        setData((await response.json()) as StepSummaryData);
      })
      .catch(() => {
        // The observability summary is optional; the trace tree remains readable without it.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceId, routeSpanId]);

  if (loading) return <div className="text-micro text-cafe-muted">Loading Step Summary…</div>;
  if (!data) return null;

  const formatCount = (count: number | null): string => (count === null ? '—' : count.toString());
  return (
    <div className="rounded-lg border border-cafe-border bg-cafe-surface-elevated p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-cafe">Step Summary</span>
        {data.is_restored && (
          <span className="rounded bg-cafe-surface px-1.5 py-0.5 text-micro text-cafe-muted">Restored (history)</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <StepCell
          label="Agent loops"
          value={
            data.agent_loop_partial ? `${formatCount(data.agent_loop_count)}+` : formatCount(data.agent_loop_count)
          }
          primary
        />
        <StepCell label="Tool calls" value={formatCount(data.tool_call_count)} />
        <StepCell label="A2A dispatch" value={formatCount(data.a2a_dispatch_count)} />
        <StepCell label="Duration" value={`${data.duration_ms.toFixed(0)} ms`} />
        <StepCell label="Tokens" value={data.token_total.toLocaleString()} />
        <StepCell label="Errors" value={data.error_count.toString()} />
      </div>
      <div className="mt-2 border-t border-cafe-border pt-2 text-micro text-cafe-muted">
        Length × Width = {formatCount(data.agent_loop_count)} loop ×{' '}
        {data.width_avg_tools_per_loop != null ? `${data.width_avg_tools_per_loop.toFixed(1)} tools/loop` : '—'}
      </div>
    </div>
  );
}

function StepCell({ label, value, primary }: { label: string; value: string; primary?: boolean }) {
  return (
    <div>
      <div className="text-micro text-cafe-muted">{label}</div>
      <div className={`font-mono text-xs ${primary ? 'font-semibold text-cafe' : 'text-cafe'}`}>{value}</div>
    </div>
  );
}
