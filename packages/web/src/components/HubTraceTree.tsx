'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
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
        rootName: (forest[0]?.span ?? traceSpans[0])!.name,
        totalDurationMs: maxEnd - minStart,
        startTime: minStart,
        spanCount: traceSpans.length,
        hasError: traceSpans.some((s) => s.status.code !== 0 && s.status.code !== 1),
      };
    })
    .sort((a, b) => b.startTime - a.startTime);
}

export function TraceBrowser() {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);

  const fetchTraces = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (search) {
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
  }, [search]);

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
          onChange={(e) => setSearch(e.target.value)}
          placeholder="traceId or catId..."
          className="flex-1 rounded-lg border border-cafe-border bg-cafe-surface px-3 py-1.5 text-sm text-cafe placeholder:text-cafe-muted focus:border-conn-blue-ring focus:outline-none"
        />
        <button
          type="button"
          onClick={fetchTraces}
          className="rounded-lg bg-conn-blue-bg px-3 py-1.5 text-xs font-medium text-conn-blue-text hover:bg-conn-blue-bg"
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

  return (
    <div className="rounded-lg border border-cafe-border bg-cafe-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-cafe-surface-elevated/50"
      >
        <span className="text-[10px] text-cafe-muted">{expanded ? '▼' : '▶'}</span>
        <span className="flex-1 truncate text-xs font-medium text-cafe">{trace.rootName}</span>
        <span className="rounded bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] text-cafe-muted">
          {trace.spanCount} span{trace.spanCount > 1 ? 's' : ''}
        </span>
        <span className="text-[10px] tabular-nums text-cafe-secondary">{trace.totalDurationMs.toFixed(0)}ms</span>
        {trace.hasError && (
          <span className="rounded bg-conn-red-bg px-1.5 py-0.5 text-[10px] font-medium text-conn-red-text">error</span>
        )}
        <span className="text-[10px] text-cafe-muted">{new Date(trace.startTime).toLocaleTimeString()}</span>
      </button>

      {expanded && (
        <div className="border-t border-cafe-border px-3 pb-3 pt-2 space-y-2">
          <div className="text-[10px] text-cafe-muted font-mono">traceId: {trace.traceId}</div>
          <TreeWaterfall trace={trace} selectedSpan={selectedSpan} onSelectSpan={setSelectedSpan} />
          {selectedSpan && <SpanDetail span={trace.spans.find((s) => s.spanId === selectedSpan)} />}
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
          <div
            key={node.span.spanId}
            onClick={() => onSelectSpan(selected ? null : node.span.spanId)}
            className={`flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-cafe-surface-elevated ${selected ? 'bg-conn-blue-bg/70' : ''}`}
          >
            <div
              className="flex items-center gap-1 truncate text-[10px]"
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
              <span className="w-14 flex-shrink-0 truncate text-[10px] text-cafe-muted">{catId}</span>
            ) : (
              <span className="w-14 flex-shrink-0" />
            )}
            <div className="relative h-3 flex-1 rounded bg-cafe-surface-elevated">
              <div
                className={`absolute h-full rounded ${statusOk ? 'bg-conn-blue-text' : 'bg-conn-red-text'}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
            <span className="w-14 flex-shrink-0 text-right text-[10px] tabular-nums text-cafe-muted">
              {node.span.durationMs.toFixed(0)}ms
            </span>
          </div>
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
              className="rounded-md bg-conn-purple-bg px-2 py-0.5 text-[10px] font-medium text-conn-purple-text transition-colors hover:bg-conn-purple-hover hover:text-white"
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
      {xrayOpen && <PromptInspector invocationId={invocationId} catId={span.attributes['agent.id'] as string} />}
    </div>
  );
}

// -- F153: Prompt X-Ray Inspector --

interface PromptCaptureData {
  captureId: string;
  invocationId: string;
  catId: string;
  model: string;
  capturedAt: number;
  systemPrompt: string;
  missionPrefix?: string;
  userPrompt: string;
  effectivePrompt: string;
  injectionDecision: {
    isResume: boolean;
    canSkipOnResume: boolean;
    forceReinjection: boolean;
    injected: boolean;
  };
  promptBytes: number;
  tokenEstimate: number;
}

type InspectorTab = 'system' | 'user' | 'effective' | 'meta';

function PromptInspector({ invocationId, catId }: { invocationId?: string; catId?: string }) {
  const [selected, setSelected] = useState<PromptCaptureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>('system');

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (invocationId) params.set('invocationId', invocationId);
        const res = await apiFetch(`/api/debug/prompt-captures?${params}`);
        if (!res.ok) {
          setError(res.status === 404 ? 'No captures found' : `Error ${res.status}`);
          return;
        }
        const index = (await res.json()) as Array<{ captureId: string; catId: string }>;
        const matching = catId ? index.filter((e) => e.catId === catId) : index;
        if (matching.length === 0) {
          setError('No prompt captures for this span. Enable with PROMPT_CAPTURE=on');
          return;
        }
        const detailRes = await apiFetch(`/api/debug/prompt-captures/${matching[0].captureId}`);
        if (detailRes.ok) {
          const data = (await detailRes.json()) as PromptCaptureData;
          setSelected(data);
        }
      } catch {
        setError('Failed to load prompt capture');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [invocationId, catId]);

  if (loading) return <div className="mt-2 text-[10px] text-cafe-muted">Loading prompt capture...</div>;
  if (error) return <div className="mt-2 text-[10px] text-cafe-secondary">{error}</div>;
  if (!selected) return null;

  const tabs: { key: InspectorTab; label: string; color: string }[] = [
    { key: 'system', label: 'System', color: 'text-conn-blue-text' },
    { key: 'user', label: 'User', color: 'text-conn-green-text' },
    { key: 'effective', label: 'Full Prompt', color: 'text-conn-purple-text' },
    { key: 'meta', label: 'Meta', color: 'text-conn-amber-text' },
  ];

  return (
    <div className="mt-3 rounded-lg border border-conn-purple-ring bg-cafe-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-conn-purple-text">Prompt X-Ray</span>
        <div className="flex items-center gap-2 text-[10px] text-cafe-muted">
          <span>{selected.model}</span>
          <span>·</span>
          <span>{(selected.promptBytes / 1024).toFixed(1)} KB</span>
          <span>·</span>
          <span>~{selected.tokenEstimate} tokens</span>
        </div>
      </div>

      <PromptTokenBar capture={selected} />

      <div className="mt-2 flex gap-1 border-b border-cafe-border pb-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-t px-2 py-0.5 text-[10px] font-medium transition-colors ${
              tab === t.key ? `${t.color} bg-cafe-surface-elevated` : 'text-cafe-muted hover:text-cafe-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-2 max-h-[300px] overflow-y-auto">
        {tab === 'system' && (
          <>
            {!selected.injectionDecision.injected && (
              <div className="mb-2 rounded bg-conn-amber-bg px-2 py-1 text-[10px] text-conn-amber-text">
                Resume — system prompt was not injected this turn
              </div>
            )}
            <PromptSection
              content={selected.systemPrompt}
              label={selected.injectionDecision.injected ? 'System Prompt' : 'System Prompt (not sent)'}
            />
          </>
        )}
        {tab === 'user' && (
          <>
            {selected.missionPrefix && (
              <PromptSection content={selected.missionPrefix} label="Mission Prefix" className="mb-2" />
            )}
            <PromptSection content={selected.userPrompt} label="User Prompt" />
          </>
        )}
        {tab === 'effective' && <PromptSection content={selected.effectivePrompt} label="Effective Prompt (Full)" />}
        {tab === 'meta' && <PromptMeta capture={selected} />}
      </div>
    </div>
  );
}

function PromptTokenBar({ capture }: { capture: PromptCaptureData }) {
  const injected = capture.injectionDecision.injected;
  const sysLen = injected ? capture.systemPrompt.length : 0;
  const userLen = capture.userPrompt.length;
  const missionLen = capture.missionPrefix?.length ?? 0;
  const total = capture.effectivePrompt.length || 1;

  const sysPct = (sysLen / total) * 100;
  const missionPct = (missionLen / total) * 100;
  const userPct = (userLen / total) * 100;

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-cafe-surface-elevated">
        <div className="bg-conn-blue-text" style={{ width: `${sysPct}%` }} title={`System: ${sysPct.toFixed(0)}%`} />
        {missionPct > 0 && (
          <div
            className="bg-conn-amber-text"
            style={{ width: `${missionPct}%` }}
            title={`Mission: ${missionPct.toFixed(0)}%`}
          />
        )}
        <div className="bg-conn-green-text" style={{ width: `${userPct}%` }} title={`User: ${userPct.toFixed(0)}%`} />
      </div>
      <div className="mt-0.5 flex gap-3 text-[10px] text-cafe-muted">
        <span>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-blue-text" /> System {sysPct.toFixed(0)}%
        </span>
        {missionPct > 0 && (
          <span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-amber-text" /> Mission{' '}
            {missionPct.toFixed(0)}%
          </span>
        )}
        <span>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-green-text" /> User {userPct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

function PromptSection({ content, label, className = '' }: { content: string; label: string; className?: string }) {
  if (!content) return <div className="text-[10px] text-cafe-muted">Empty</div>;
  return (
    <div className={className}>
      <div className="mb-1 text-[10px] font-medium text-cafe-muted">{label}</div>
      <pre className="whitespace-pre-wrap break-words rounded bg-cafe-surface p-2 font-mono text-[10px] leading-relaxed text-cafe">
        {content}
      </pre>
    </div>
  );
}

function PromptMeta({ capture }: { capture: PromptCaptureData }) {
  const { injectionDecision } = capture;
  return (
    <div className="space-y-2 text-[10px]">
      <div>
        <div className="font-medium text-cafe-muted">Capture Info</div>
        <div className="ml-2 space-y-0.5">
          <div>
            <span className="text-cafe-muted">captureId:</span> <span className="font-mono">{capture.captureId}</span>
          </div>
          <div>
            <span className="text-cafe-muted">invocationId:</span>{' '}
            <span className="font-mono">{capture.invocationId}</span>
          </div>
          <div>
            <span className="text-cafe-muted">catId:</span> {capture.catId}
          </div>
          <div>
            <span className="text-cafe-muted">model:</span> {capture.model}
          </div>
          <div>
            <span className="text-cafe-muted">captured:</span> {new Date(capture.capturedAt).toLocaleString()}
          </div>
        </div>
      </div>
      <div>
        <div className="font-medium text-cafe-muted">Injection Decision</div>
        <div className="ml-2 space-y-0.5">
          <div>
            <span className="text-cafe-muted">injected:</span>{' '}
            <span className={injectionDecision.injected ? 'text-conn-green-text' : 'text-conn-red-text'}>
              {String(injectionDecision.injected)}
            </span>
          </div>
          <div>
            <span className="text-cafe-muted">isResume:</span> {String(injectionDecision.isResume)}
          </div>
          <div>
            <span className="text-cafe-muted">canSkipOnResume:</span> {String(injectionDecision.canSkipOnResume)}
          </div>
          <div>
            <span className="text-cafe-muted">forceReinjection:</span> {String(injectionDecision.forceReinjection)}
          </div>
        </div>
      </div>
      <div>
        <div className="font-medium text-cafe-muted">Size</div>
        <div className="ml-2 space-y-0.5">
          <div>
            <span className="text-cafe-muted">bytes:</span> {capture.promptBytes.toLocaleString()}
          </div>
          <div>
            <span className="text-cafe-muted">tokens (est):</span> ~{capture.tokenEstimate.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}
