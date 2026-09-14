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
  window,
  readiness,
  loading,
  error,
  capped,
}: {
  segmentId: string;
  observations: TraceTheaterObservation[];
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
    /** The segment this row belongs to — not necessarily the page it was opened from. */
    segmentId: string;
  } | null>(null);
  const trigger = readiness?.trigger;
  const cycleStart = cycleStartMs(trigger, window);
  return (
    <div className="space-y-3" data-testid="segment-trace-theater">
      <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
            触发条件（满足任一条件触发）
          </SettingsText>
          <div className="text-xs text-cafe-muted">
            <div>
              周期起点：
              <span className="ml-1 text-cafe-secondary">
                {cycleStart !== null ? new Date(cycleStart).toLocaleString() : '窗口未知'}
              </span>
            </div>
          </div>
        </div>
        <div className="mt-3">
          {loading ? '加载中…' : trigger ? <TriggerRules trigger={trigger} /> : '当前 Unit 尚无评估触发配置'}
        </div>
        {error && (
          <SettingsText as="p" variant="xs" tone="red" className="mt-2">
            {error}
          </SettingsText>
        )}
      </section>

      <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          周期内反例Tracing
        </SettingsText>
        <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
          按 Objective 计数，与上方触发条件同源；非本段的反例会标出归属段。
        </SettingsText>
        {!loading && (readiness?.structuredCounterexamples.length ?? 0) === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            周期内暂无明确反例；Tracing 仍持续累计。
          </SettingsText>
        ) : (
          <div className="mt-2 space-y-1.5">
            {readiness?.structuredCounterexamples.map((counterexample) => (
              <button
                type="button"
                key={counterexample.annotationId}
                onClick={() =>
                  setSelected({
                    ...counterexample,
                    pipelineStatus: 'structured',
                    // The list is Objective-scoped, so a row may belong to a sibling
                    // segment. Replaying the page's segment would fetch a snapshot
                    // this evidence never came from. Stay on the page when it is one
                    // of the row's segments; otherwise follow the row.
                    segmentId: counterexample.segmentIds.includes(segmentId)
                      ? segmentId
                      : (counterexample.segmentIds[0] ?? segmentId),
                  })
                }
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-card-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
              >
                <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                  {new Date(counterexample.createdAt).toLocaleString()}
                </span>
                <SettingsBadge tone="amber" size="xxs">
                  反例信号
                </SettingsBadge>
                {!counterexample.segmentIds.includes(segmentId) && (
                  <SettingsBadge tone="slate" size="xxs">
                    归属 {counterexample.segmentIds.join('、') || '本 Objective'}
                  </SettingsBadge>
                )}
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
        <summary className="cursor-pointer text-sm font-semibold text-cafe">
          <span>周期内注入Tracing</span>
          <span className="ml-2 text-cafe-secondary">
            {trigger ? `${trigger.segment.injectionCount}/${trigger.objective.cumulative.count}` : '—/—'}
          </span>
          {trigger && trigger.segment.disabledCount > 0 && (
            <span className="ml-2 text-xs font-normal text-cafe-muted">禁用 {trigger.segment.disabledCount} 次</span>
          )}
        </summary>
        {observations.length === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            当前周期窗内暂无注入记录
          </SettingsText>
        ) : (
          <div className="mt-2 space-y-1.5">
            {observations.map((observation) => (
              <button
                type="button"
                key={`${observation.threadId}:${observation.turnId}`}
                onClick={() => setSelected({ ...observation, segmentId })}
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
              >
                <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                  {new Date(observation.timestamp).toLocaleString()}
                </span>
                <SettingsBadge tone="emerald" size="xxs">
                  已注入
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
            当前仅展示最近 100 次注入；上方计数仍为完整周期窗精确聚合。
          </SettingsText>
        )}
      </details>
      {selected && (
        <SegmentReplayPanel
          segmentId={selected.segmentId}
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

/**
 * Trigger rules are Objective-cycle pool counts. Segment activity and replay
 * below use injection/disabled vocabulary so the two coordinates cannot be
 * mistaken for the same Tracing count.
 */
function TriggerRules({ trigger }: { trigger: SegmentTracingEvaluationView['trigger'] }) {
  const objective = trigger.objective;
  const countThresholdSatisfied =
    objective.cumulative.count >= objective.cumulative.threshold ||
    objective.counterexamples.count >= objective.counterexamples.threshold;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-[72px] shrink-0 text-xs text-cafe-muted">归属</span>
        <span className="font-mono text-xs text-cafe-secondary">{objective.objectiveId}</span>
        {objective.evalStatus !== 'idle' && <EvaluationStatusBadge status={objective.evalStatus} />}
        {objective.lifecycle !== 'active' && <LifecycleBadge lifecycle={objective.lifecycle} />}
        {objective.triggeredBy.map((route) => (
          <SettingsBadge key={route} tone="blue" size="xxs">
            {routeLabel(route)} 已触发
          </SettingsBadge>
        ))}
      </div>
      <div className="grid gap-x-4 gap-y-1 text-cafe-muted sm:grid-cols-4">
        <TriggerProgress
          label="周期累计Tracing"
          value={`${objective.cumulative.count}/${objective.cumulative.threshold} 条`}
        />
        <TriggerProgress
          label="周期反例Tracing"
          value={`${objective.counterexamples.count}/${objective.counterexamples.threshold} 次`}
        />
        <TriggerProgress
          label="最大累计时间窗"
          value={`${formatDuration(objective.cadence.elapsedMs)}/${formatDuration(objective.cadence.thresholdMs)}${
            !objective.cadence.eligible ? '（至少需 1 条 Tracing）' : ''
          }`}
        />
        <TriggerProgress label="最短采集评估时间" value={formatDuration(objective.minimumIntervalMs)} />
      </div>
      {countThresholdSatisfied && Date.now() < objective.cycleStartMs + objective.minimumIntervalMs && (
        <div className="text-xs text-cafe-muted">
          最早可评估时间：{' '}
          <span className="text-cafe-secondary">
            {new Date(objective.cycleStartMs + objective.minimumIntervalMs).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

function TriggerProgress({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-micro text-cafe-muted">{label}</div>
      <div className="mt-0.5 whitespace-nowrap text-xs text-cafe-secondary">{value}</div>
    </div>
  );
}

const EVALUATION_STATUS_LABEL = {
  requested: { label: '待评估', tone: 'blue' },
  retriggered: { label: '已重触发', tone: 'amber' },
  written: { label: '评估已回写', tone: 'emerald' },
  stalled: { label: '评估停滞', tone: 'red' },
} as const;

function EvaluationStatusBadge({
  status,
}: {
  status: Exclude<SegmentTracingEvaluationView['trigger']['objective']['evalStatus'], 'idle'>;
}) {
  const presentation = EVALUATION_STATUS_LABEL[status];
  return (
    <SettingsBadge tone={presentation.tone} size="xxs">
      {presentation.label}
    </SettingsBadge>
  );
}

const LIFECYCLE_LABEL = {
  dormant: { label: '已休眠', tone: 'amber' },
  retired: { label: '已退役', tone: 'slate' },
} as const;

function LifecycleBadge({
  lifecycle,
}: {
  lifecycle: Exclude<SegmentTracingEvaluationView['trigger']['objective']['lifecycle'], 'active'>;
}) {
  const presentation = LIFECYCLE_LABEL[lifecycle];
  return (
    <SettingsBadge tone={presentation.tone} size="xxs">
      {presentation.label}
    </SettingsBadge>
  );
}

/** Cycle start comes from the segment's sole Objective; falls back to the version window. */
function cycleStartMs(
  trigger: SegmentTracingEvaluationView['trigger'] | undefined,
  window: { startMs: number; endMs: number } | null,
): number | null {
  if (trigger && trigger.objective.cycleStartMs >= 0) return trigger.objective.cycleStartMs;
  return window?.startMs ?? null;
}

function routeLabel(route: SegmentTracingEvaluationView['trigger']['objective']['triggeredBy'][number]) {
  return { cumulative: '累计', counterexamples: '反例', cadence: '周期' }[route];
}

function formatDuration(value: number): string {
  const days = value / (24 * 60 * 60 * 1000);
  if (days >= 1) return `${formatMagnitude(days)} 天`;
  const hours = value / (60 * 60 * 1000);
  return `${formatMagnitude(hours)} 小时`;
}

const formatMagnitude = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
