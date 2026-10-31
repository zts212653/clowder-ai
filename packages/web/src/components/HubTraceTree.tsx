'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatTechnicalLabelResolver } from '@/hooks/useCatNameResolver';
import { apiFetch } from '@/utils/api-client';
import { InvocationPromptCaptureInspector } from './InvocationPromptCaptureInspector';
import { StepSummaryPanel } from './StepSummaryPanel';
import { buildForest, flattenForest, type SpanNode, type TraceSpan } from './trace-tree-utils';

interface TraceGroup {
  traceId: string;
  spans: TraceSpan[];
  forest: SpanNode[];
  rootName: string;
  totalDurationMs: number;
  startTime: number;
  spanCount: number;
  hasError: boolean;
}

function groupByTrace(spans: TraceSpan[]): TraceGroup[] {
  const map = new Map<string, TraceSpan[]>();
  for (const s of spans) {
    const arr = map.get(s.traceId) ?? [];
    arr.push(s);
    map.set(s.traceId, arr);
  }
  return [...map.entries()]
    .map(([traceId, traceSpans]) => {
      const forest = buildForest(traceSpans);
      const minStart = Math.min(...traceSpans.map((s) => s.startTimeMs));
      const maxEnd = Math.max(...traceSpans.map((s) => s.endTimeMs));
      return {
        traceId,
        spans: traceSpans,
        forest,
        rootName: forest[0]?.span.name ?? traceSpans[0]?.name ?? 'trace',
        totalDurationMs: maxEnd - minStart,
        startTime: minStart,
        spanCount: traceSpans.length,
        hasError: traceSpans.some((s) => s.status.code !== 0 && s.status.code !== 1),
      };
    })
    .sort((a, b) => b.startTime - a.startTime);
}

export function TraceBrowser({ initialInvocationId }: { initialInvocationId?: string } = {}) {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(initialInvocationId ?? '');
  const [invocationFilter, setInvocationFilter] = useState(initialInvocationId);
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);

  const fetchTraces = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (invocationFilter) {
        params.set('invocationId', invocationFilter);
      } else if (search) {
        if (search.length === 32 && /^[0-9a-f]+$/.test(search)) {
          params.set('traceId', search);
        } else {
          params.set('catId', search);
        }
      }
      const res = await apiFetch(`/api/telemetry/traces?${params}`);
      if (res.ok) {
        const data = (await res.json()) as { spans: TraceSpan[] };
        setSpans(data.spans);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [invocationFilter, search]);

  useEffect(() => {
    setSearch(initialInvocationId ?? '');
    setInvocationFilter(initialInvocationId);
  }, [initialInvocationId]);

  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  const traces = groupByTrace(spans);

  return (
    <div className="space-y-3" data-guide-id="observability.trace-browser">
      <div className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setInvocationFilter(undefined);
          }}
          placeholder="traceId, invocationId or catId..."
          className="flex-1 rounded-lg bg-[var(--console-field-bg)] px-3 py-1.5 text-xs text-cafe placeholder:text-cafe-muted outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)]"
        />
        <button
          type="button"
          onClick={fetchTraces}
          disabled={!search.trim()}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover disabled:opacity-50"
        >
          Search
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-cafe-muted">...</p>
      ) : traces.length === 0 ? (
        <p className="text-sm text-cafe-secondary">No traces found.</p>
      ) : (
        <div className="max-h-[500px] space-y-2 overflow-y-auto">
          {traces.map((trace) => (
            <TraceCard
              key={trace.traceId}
              trace={trace}
              expanded={expandedTrace === trace.traceId}
              onToggle={() => setExpandedTrace(expandedTrace === trace.traceId ? null : trace.traceId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceCard({ trace, expanded, onToggle }: { trace: TraceGroup; expanded: boolean; onToggle: () => void }) {
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
  const selectedSpanData = selectedSpan ? trace.spans.find((s) => s.spanId === selectedSpan) : undefined;
  const selectedRouteSpanId = selectedSpanData?.name === 'cat_cafe.route' ? selectedSpanData.spanId : undefined;

  return (
    <div className="rounded-lg border border-cafe-border bg-cafe-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-cafe-surface-elevated/50"
      >
        <span className="text-micro text-cafe-muted">{expanded ? '▼' : '▶'}</span>
        <span className="flex-1 truncate text-xs font-medium text-cafe">{trace.rootName}</span>
        <span className="rounded bg-cafe-surface-elevated px-1.5 py-0.5 text-micro text-cafe-muted">
          {trace.spanCount} span{trace.spanCount > 1 ? 's' : ''}
        </span>
        <span className="text-micro tabular-nums text-cafe-secondary">{trace.totalDurationMs.toFixed(0)}ms</span>
        {trace.hasError && (
          <span className="rounded bg-conn-red-bg px-1.5 py-0.5 text-micro font-medium text-conn-red-text">error</span>
        )}
        <span className="text-micro text-cafe-muted">{new Date(trace.startTime).toLocaleTimeString()}</span>
      </button>

      {expanded && (
        <div className="border-t border-cafe-border px-3 pb-3 pt-2 space-y-2">
          <div className="text-micro text-cafe-muted font-mono">traceId: {trace.traceId}</div>
          <StepSummaryPanel traceId={trace.traceId} routeSpanId={selectedRouteSpanId} />
          <TreeWaterfall trace={trace} selectedSpan={selectedSpan} onSelectSpan={setSelectedSpan} />
          {selectedSpan && <SpanDetail span={selectedSpanData} />}
        </div>
      )}
    </div>
  );
}

function TreeWaterfall({
  trace,
  selectedSpan,
  onSelectSpan,
}: {
  trace: TraceGroup;
  selectedSpan: string | null;
  onSelectSpan: (id: string | null) => void;
}) {
  const resolveCatTechnicalLabel = useCatTechnicalLabelResolver();
  const flat = flattenForest(trace.forest);
  const totalDuration = trace.totalDurationMs || 1;

  return (
    <div className="space-y-0.5">
      {flat.map((node) => {
        const left = ((node.span.startTimeMs - trace.startTime) / totalDuration) * 100;
        const width = Math.max((node.span.durationMs / totalDuration) * 100, 0.5);
        const statusOk = node.span.status.code === 0 || node.span.status.code === 1;
        const selected = selectedSpan === node.span.spanId;
        const catId = node.span.attributes['agent.id'] as string | undefined;

        return (
          <button
            type="button"
            key={node.span.spanId}
            onClick={() => onSelectSpan(selected ? null : node.span.spanId)}
            className={`flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-cafe-surface-elevated ${selected ? 'bg-conn-blue-bg/70' : ''}`}
          >
            <div
              className="flex items-center gap-1 truncate text-micro"
              style={{ paddingLeft: `${node.depth * 16}px`, width: '160px', flexShrink: 0 }}
            >
              {node.depth > 0 && <span className="text-cafe-muted/50">{'└'}</span>}
              <span
                className={`truncate ${node.depth === 0 ? 'font-medium text-cafe' : 'text-cafe-secondary'}`}
                title={node.span.name}
              >
                {node.span.name}
              </span>
            </div>
            {catId ? (
              <span
                className="w-24 flex-shrink-0 truncate text-micro text-cafe-muted"
                title={resolveCatTechnicalLabel(catId)}
              >
                {resolveCatTechnicalLabel(catId)}
              </span>
            ) : (
              <span className="w-24 flex-shrink-0" />
            )}
            <div className="relative h-3 flex-1 rounded bg-cafe-surface-elevated">
              <div
                className={`absolute h-full rounded ${statusOk ? 'bg-conn-blue-text' : 'bg-conn-red-text'}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
            <span className="w-14 flex-shrink-0 text-right text-micro tabular-nums text-cafe-muted">
              {node.span.durationMs.toFixed(0)}ms
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SpanDetail({ span }: { span: TraceSpan | undefined }) {
  const [xrayOpen, setXrayOpen] = useState(false);

  if (!span) return null;

  const invocationId = span.attributes.invocationId as string | undefined;
  const hasInvocationId = Boolean(invocationId);

  return (
    <div className="rounded-lg bg-cafe-surface-elevated p-3 text-xs">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-cafe-muted">spanId:</span> <span className="font-mono">{span.spanId}</span>
          </div>
          {hasInvocationId && (
            <button
              type="button"
              onClick={() => setXrayOpen(!xrayOpen)}
              className="rounded-md bg-conn-purple-bg px-2 py-0.5 text-micro font-medium text-conn-purple-text transition-colors hover:bg-conn-purple-hover hover:text-[var(--cafe-surface)]"
            >
              {xrayOpen ? 'Close' : 'X-Ray'}
            </button>
          )}
        </div>
        {span.parentSpanId && (
          <div>
            <span className="text-cafe-muted">parent:</span> <span className="font-mono">{span.parentSpanId}</span>
          </div>
        )}
        <div>
          <span className="text-cafe-muted">duration:</span>{' '}
          <span className="tabular-nums">{span.durationMs.toFixed(1)}ms</span>
          <span className="ml-2 text-cafe-muted">
            ({new Date(span.startTimeMs).toLocaleTimeString()} → {new Date(span.endTimeMs).toLocaleTimeString()})
          </span>
        </div>
        {Object.keys(span.attributes).length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-cafe-muted">Attributes:</div>
            {Object.entries(span.attributes).map(([k, v]) => (
              <div key={k} className="ml-2">
                <span className="text-cafe-muted">{k}:</span> {String(v)}
              </div>
            ))}
          </div>
        )}
        {span.events.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-cafe-muted">Events ({span.events.length}):</div>
            {span.events.map((ev, i) => (
              <div key={`${ev.timeMs}-${i}`} className="ml-2">
                {new Date(ev.timeMs).toLocaleTimeString()} - {ev.name}
              </div>
            ))}
          </div>
        )}
      </div>
      {xrayOpen && (
        <InvocationPromptCaptureInspector invocationId={invocationId} catId={span.attributes['agent.id'] as string} />
      )}
    </div>
  );
}
