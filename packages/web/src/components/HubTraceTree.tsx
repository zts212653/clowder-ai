'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatTechnicalLabelResolver } from '@/hooks/useCatNameResolver';
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
          <div
            key={node.span.spanId}
            onClick={() => onSelectSpan(selected ? null : node.span.spanId)}
            className={`flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-cafe-surface-elevated ${selected ? 'bg-conn-blue-bg/70' : ''}`}
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
  // AC-G10 (Phase G native L0 closure / KD-44)
  nativeSystemPrompt?: string;
  nativeSystemPromptSource?: 'f203-l0';
  nativeSystemTokenEstimate?: number;
  totalTokenEstimate?: number;
  captureDiagnostics?: readonly string[];
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

  if (loading) return <div className="mt-2 text-micro text-cafe-muted">Loading prompt capture...</div>;
  if (error) return <div className="mt-2 text-micro text-cafe-secondary">{error}</div>;
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
        <div className="flex items-center gap-2 text-micro text-cafe-muted">
          <span>{selected.model}</span>
          <span>·</span>
          <span>{(selected.promptBytes / 1024).toFixed(1)} KB</span>
          <span>·</span>
          {/* AC-G10: prefer totalTokenEstimate (msg + native L0) so F203
              providers no longer silently under-count. Pre-AC-G10 captures
              omit totalTokenEstimate → fallback to tokenEstimate (msg only). */}
          <span>~{selected.totalTokenEstimate ?? selected.tokenEstimate} tokens</span>
        </div>
      </div>

      <PromptTokenBar capture={selected} />

      <div className="mt-2 flex gap-1 border-b border-cafe-border pb-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-t px-2 py-0.5 text-micro font-medium transition-colors ${
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
            {/* AC-G10 (砚砚 Design Gate position 3): zoned display. Native L0
                section first (provider's actual system-role channel), then
                message-system / pack appendix. Resume amber banner only
                applies to the message-system path — native L0 is sent every
                turn for F203 providers regardless of `injected` flag. */}
            {selected.nativeSystemPrompt && (
              <PromptSection
                content={selected.nativeSystemPrompt}
                label={`Native L0 (system role)${
                  selected.nativeSystemPromptSource ? ` · ${selected.nativeSystemPromptSource}` : ''
                }`}
                className="mb-2"
              />
            )}
            {!selected.injectionDecision.injected && (
              <div className="mb-2 rounded bg-conn-amber-bg px-2 py-1 text-micro text-conn-amber-text">
                {selected.nativeSystemPrompt
                  ? 'Resume — message-system pack not appended this turn (Native L0 still sent via system-role channel)'
                  : 'Resume — system prompt was not injected this turn'}
              </div>
            )}
            <PromptSection
              content={selected.systemPrompt}
              label={
                selected.nativeSystemPrompt
                  ? selected.injectionDecision.injected
                    ? 'Message system prompt (pack appendix)'
                    : 'Message system prompt (pack appendix · not sent this turn)'
                  : selected.injectionDecision.injected
                    ? 'System Prompt'
                    : 'System Prompt (not sent)'
              }
            />
            {selected.captureDiagnostics && selected.captureDiagnostics.length > 0 && (
              <div className="mt-2 rounded border border-conn-amber-ring bg-conn-amber-bg p-2 text-micro text-conn-amber-text">
                <div className="mb-1 font-medium">Capture diagnostics</div>
                <ul className="ml-3 list-disc space-y-0.5">
                  {selected.captureDiagnostics.map((d, i) => (
                    <li key={`${d}-${i}`}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
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
  // AC-G10: include native L0 length when present so F203 providers no
  // longer silently under-display total prompt size in the bar.
  const nativeLen = capture.nativeSystemPrompt?.length ?? 0;
  const sysLen = injected ? capture.systemPrompt.length : 0;
  const userLen = capture.userPrompt.length;
  const missionLen = capture.missionPrefix?.length ?? 0;
  const total = nativeLen + capture.effectivePrompt.length || 1;

  const nativePct = (nativeLen / total) * 100;
  const sysPct = (sysLen / total) * 100;
  const missionPct = (missionLen / total) * 100;
  const userPct = (userLen / total) * 100;

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-cafe-surface-elevated">
        {nativePct > 0 && (
          <div
            className="bg-conn-purple-text"
            style={{ width: `${nativePct}%` }}
            title={`Native L0: ${nativePct.toFixed(0)}%`}
          />
        )}
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
      <div className="mt-0.5 flex gap-3 text-micro text-cafe-muted">
        {nativePct > 0 && (
          <span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-purple-text" /> Native L0{' '}
            {nativePct.toFixed(0)}%
          </span>
        )}
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
  if (!content) return <div className="text-micro text-cafe-muted">Empty</div>;
  return (
    <div className={className}>
      <div className="mb-1 text-micro font-medium text-cafe-muted">{label}</div>
      <pre className="whitespace-pre-wrap break-words rounded bg-cafe-surface p-2 font-mono text-micro leading-relaxed text-cafe">
        {content}
      </pre>
    </div>
  );
}

function PromptMeta({ capture }: { capture: PromptCaptureData }) {
  const resolveCatTechnicalLabel = useCatTechnicalLabelResolver();
  const { injectionDecision } = capture;
  return (
    <div className="space-y-2 text-micro">
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
            <span className="text-cafe-muted">member:</span> {resolveCatTechnicalLabel(capture.catId)}
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
            <span className="text-cafe-muted">tokens · message (est):</span> ~{capture.tokenEstimate.toLocaleString()}
          </div>
          {/* AC-G10 (砚砚 立场 4): split token breakdown — Hub showed
              tokenEstimate as if it were total before, which silently
              under-counted F203 providers. Now native L0 + total are
              shown separately so the gap is visible. */}
          {capture.nativeSystemTokenEstimate !== undefined && (
            <div>
              <span className="text-cafe-muted">tokens · native L0 (est):</span> ~
              {capture.nativeSystemTokenEstimate.toLocaleString()}
              {capture.nativeSystemPromptSource ? (
                <span className="ml-1 text-cafe-muted">({capture.nativeSystemPromptSource})</span>
              ) : null}
            </div>
          )}
          {capture.totalTokenEstimate !== undefined && capture.totalTokenEstimate !== capture.tokenEstimate && (
            <div>
              <span className="text-cafe-muted">tokens · total (est):</span> ~
              {capture.totalTokenEstimate.toLocaleString()}
            </div>
          )}
        </div>
      </div>
      {capture.captureDiagnostics && capture.captureDiagnostics.length > 0 && (
        <div>
          <div className="font-medium text-cafe-muted">Capture Diagnostics</div>
          <ul className="ml-3 list-disc space-y-0.5">
            {capture.captureDiagnostics.map((d, i) => (
              <li key={`${d}-${i}`}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── F153 Phase I: Step Summary panel ──────────────────────────────

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

function StepSummaryPanel({ traceId, routeSpanId }: { traceId: string; routeSpanId?: string }) {
  const [data, setData] = useState<StepSummaryData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    const qs = new URLSearchParams({ traceId });
    if (routeSpanId) qs.set('routeSpanId', routeSpanId);
    apiFetch(`/api/telemetry/step-summary?${qs.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setData(null);
          return;
        }
        const json = (await res.json()) as StepSummaryData;
        setData(json);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceId, routeSpanId]);

  if (loading) {
    return <div className="text-micro text-cafe-muted">Loading Step Summary…</div>;
  }
  if (!data) return null;

  // '—' for null (AC-I4 / AC-I7 non-degradation — never render 0 for unknown).
  const fmt = (n: number | null): string => (n === null ? '—' : n.toString());

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
          value={data.agent_loop_partial ? `${fmt(data.agent_loop_count)}+` : fmt(data.agent_loop_count)}
          primary
        />
        <StepCell label="Tool calls" value={fmt(data.tool_call_count)} />
        <StepCell label="A2A dispatch" value={fmt(data.a2a_dispatch_count)} />
        <StepCell label="Duration" value={`${data.duration_ms.toFixed(0)} ms`} />
        <StepCell label="Tokens" value={data.token_total.toLocaleString()} />
        <StepCell label="Errors" value={data.error_count.toString()} />
      </div>
      <div className="mt-2 border-t border-cafe-border pt-2 text-micro text-cafe-muted">
        Length × Width = {fmt(data.agent_loop_count)} loop ×{' '}
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
