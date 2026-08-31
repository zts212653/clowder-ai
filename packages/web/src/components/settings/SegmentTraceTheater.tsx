'use client';

import type { SegmentTracingEvaluationView } from '@cat-cafe/shared';
import { useState } from 'react';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentReplayPanel } from './SegmentReplayPanel';

export interface TraceTheaterObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

export function SegmentTraceTheater({
  segmentId,
  observations,
  total,
  window,
  readiness,
  loading,
  error,
  capped,
}: {
  segmentId: string;
  observations: TraceTheaterObservation[];
  total: number;
  window: { startMs: number; endMs: number } | null;
  readiness: SegmentTracingEvaluationView | null;
  loading?: boolean;
  error?: string | null;
  capped?: boolean;
}) {
  const [selected, setSelected] = useState<{
    threadId: string;
    turnId: string;
    catId: string;
    pipelineStatus: string;
  } | null>(null);
  const trigger = readiness?.trigger;
  return (
    <div className="space-y-3" data-testid="segment-trace-theater">
      <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <MetaRow label="触发条件">
            {loading ? '加载中…' : trigger ? <TriggerRules trigger={trigger} /> : '当前 Unit 尚无评估触发配置'}
          </MetaRow>
          <MetaRow label="周期起点">
            {cycleStartMs(trigger, window) ? new Date(cycleStartMs(trigger, window)!).toLocaleString() : '窗口未知'}
          </MetaRow>
          <MetaRow label="待分类">{readiness ? `${readiness.unclassifiedEpisodeCount} 条` : '—'}</MetaRow>
        </div>
        {error && (
          <SettingsText as="p" variant="xs" tone="red" className="mt-2">
            {error}
          </SettingsText>
        )}
      </section>

      <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          结构化反例
        </SettingsText>
        {!loading && (readiness?.structuredCounterexamples.length ?? 0) === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            当前窗口暂无明确反例；原始 Tracing 仍持续累计。
          </SettingsText>
        ) : (
          <div className="mt-2 space-y-1.5">
            {readiness?.structuredCounterexamples.map((counterexample) => (
              <button
                type="button"
                key={counterexample.annotationId}
                onClick={() => setSelected({ ...counterexample, pipelineStatus: 'structured' })}
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-card-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
              >
                <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                  {new Date(counterexample.createdAt).toLocaleString()}
                </span>
                <SettingsBadge tone="amber" size="xxs">
                  明确反例
                </SettingsBadge>
                <span className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">
                  {counterexample.rationale ?? counterexample.incidentKey}
                </span>
                <span className="shrink-0 text-xs text-cafe-muted" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <details className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <summary className="cursor-pointer text-xs font-semibold text-cafe-secondary">
          原始 Tracing 记录（{total}）
        </summary>
        <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
          点击记录查看完整现场
        </SettingsText>
        {observations.length === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            当前窗口暂无原始记录
          </SettingsText>
        ) : (
          <div className="mt-2 space-y-1.5">
            {observations.map((observation) => (
              <button
                type="button"
                key={`${observation.threadId}:${observation.turnId}`}
                onClick={() => setSelected(observation)}
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
              >
                <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                  {new Date(observation.timestamp).toLocaleString()}
                </span>
                <SettingsBadge tone={observation.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
                  {observation.pipelineStatus === 'fired' ? '已注入' : '已观测'}
                </SettingsBadge>
                <span className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">@{observation.catId}</span>
                <span className="shrink-0 text-micro text-cafe-muted">{observation.charCount} chars</span>
                <span className="shrink-0 text-xs text-cafe-muted" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        )}
        {capped && (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            当前仅展示最近 100 场；累计记录仍为完整窗口计数。
          </SettingsText>
        )}
      </details>
      {selected && (
        <SegmentReplayPanel
          segmentId={segmentId}
          threadId={selected.threadId}
          turnId={selected.turnId}
          catId={selected.catId}
          pipelineStatus={selected.pipelineStatus}
          isOpen
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** Static trigger rules — no live counts or timestamps. */
function TriggerRules({ trigger }: { trigger: SegmentTracingEvaluationView['trigger'] }) {
  return (
    <div className="space-y-0.5">
      <div>满足任一条件即触发 Unit 评估</div>
      <div className="text-cafe-muted">· Tracing 累计达到 {trigger.traceRequired} 条</div>
      {trigger.counterexampleRequired != null && (
        <div className="text-cafe-muted">· 明确反例累计 {trigger.counterexampleRequired} 条</div>
      )}
    </div>
  );
}

/** Cycle start = earliest per-Objective readiness window start; falls back to version window. */
function cycleStartMs(
  trigger: SegmentTracingEvaluationView['trigger'] | undefined,
  window: { startMs: number; endMs: number } | null,
): number | null {
  const starts = trigger?.perObjective?.map((po) => po.windowStartMs).filter((v): v is number => v > 0);
  if (starts && starts.length > 0) return Math.min(...starts);
  return window?.startMs ?? null;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[72px] shrink-0 text-cafe-muted">{label}</span>
      <span className="min-w-0 text-cafe-secondary">{children}</span>
    </div>
  );
}
