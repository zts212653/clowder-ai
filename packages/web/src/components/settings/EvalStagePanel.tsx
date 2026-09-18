'use client';

/**
 * F257 Phase D — Eval stage detail panel.
 *
 * Shows evaluation metrics for a version epoch:
 *   - With verdict: judgment result + injection/violation stats
 *   - Pending: observation count, guard events, trigger progress bar
 *
 * Extracted from LifelineStageDetail to stay within 350-line limit.
 */

import type { GuardMetric } from '@cat-cafe/shared';
import { SettingsBadge, SettingsText } from './primitives';
import { explainVerdict } from './verdict-explanations';

// ── Types ────────────────────────────────────────────────────────

interface EvalStageSummary {
  verdict: string | null;
  injectionCount: number;
  violationCount: number;
  evaluatedAt: number | null;
  /** 判据②: the judgment's OWN eval sampling window [startMs,endMs). null/undefined = legacy (fail-visible). */
  evalWindow?: { startMs: number; endMs: number } | null;
  /** 判据② P2 (sol R5): why evalWindow is null — legacy-missing vs invalid-present (corrupted). */
  evalWindowGap?: string | null;
  /** 判据②: denominator semantics of the counts. null/undefined = legacy (fail-visible). */
  denominatorKind?: string | null;
  /** 判据② P2 (sol R5): why denominatorKind is null — legacy-missing vs invalid-present. */
  denominatorGap?: string | null;
}

interface TracingStageSummary {
  /** EXACT full-window aggregate (sol R6) — only the detail row list is capped, never the counts. */
  observationCount: number;
  /** 判据② P1 (sol R5): producer-semantics fired count (segment-judgment-engine isFired). */
  firedCount: number;
  /** Exact rows where this segment was disabled in the current query window. */
  disabledCount: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface EvalDetailProps {
  version: number;
  eval: EvalStageSummary | null;
  tracing: TracingStageSummary | null;
  /** Per-guard event counts for this epoch's time window, sorted by count desc. */
  guardMetrics: GuardMetric[];
  /**
   * 判据② P1-1 (sol R1): the CURRENT lifeline query window — shown side-by-side
   * with the historical eval coordinates so tracing(N) vs eval counts are
   * visible as two distinct coordinates in ONE viewport. Never rendered AS the
   * eval window.
   */
  queryWindow?: { startMs: number; endMs: number } | null;
}

// ── Constants ────────────────────────────────────────────────────

/** Eval trigger threshold: ≥3 guard events within 7-day window. */
const EVAL_TRIGGER_THRESHOLD = 3;

const formatTs = (ms: number) => new Date(ms).toLocaleString();

// ── Components ───────────────────────────────────────────────────

export function EvalStagePanel({ version, eval: evalData, tracing, guardMetrics, queryWindow }: EvalDetailProps) {
  const obsCount = tracing?.observationCount ?? 0;
  const firedCount = tracing?.firedCount ?? 0;

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{version} — Eval
      </SettingsText>

      {evalData?.verdict ? (
        <div className="space-y-2">
          <VerdictRow verdict={evalData.verdict} />
          <InfoRow label="注入次数">{evalData.injectionCount}</InfoRow>
          <InfoRow label="违规次数">{evalData.violationCount}</InfoRow>
          {evalData.injectionCount > 0 && (
            <InfoRow label="违规率">{((evalData.violationCount / evalData.injectionCount) * 100).toFixed(1)}%</InfoRow>
          )}
          {/* 判据②: the judgment's OWN eval sampling window — distinct coordinate from the query window */}
          <EvalWindowRow evalWindow={evalData.evalWindow} gap={evalData.evalWindowGap} />
          <DenominatorRow denominatorKind={evalData.denominatorKind} gap={evalData.denominatorGap} />
          {evalData.evaluatedAt && <InfoRow label="评估时间">{formatTs(evalData.evaluatedAt)}</InfoRow>}
          {/* 判据② P1-1 (sol R1): coordinate contrast — the current query-window
              metrics next to the historical eval coordinates, so the two read as
              distinct coordinates at a glance.
              判据② P1 (sol R5/R6): the current side shows the REAL metric —
              fired-count (producer semantics), exact full-window aggregate —
              never mislabels observation rows as injections. */}
          {queryWindow && (
            <CoordinateContrastRow obsCount={obsCount} firedCount={firedCount} queryWindow={queryWindow} />
          )}
        </div>
      ) : (
        <EvalPendingMetrics obsCount={obsCount} firedCount={firedCount} guardMetrics={guardMetrics} />
      )}
    </>
  );
}

/** 判据② P1-1: compact coordinate-contrast block — current query window vs eval window. */
function CoordinateContrastRow({
  obsCount,
  firedCount,
  queryWindow,
}: {
  obsCount: number;
  firedCount: number;
  queryWindow: { startMs: number; endMs: number };
}) {
  return (
    <div className="mt-1 space-y-1 rounded-lg px-2 py-1.5" style={{ backgroundColor: 'var(--console-elevated-bg)' }}>
      <SettingsText as="p" variant="xs" tone="muted" className="font-semibold">
        坐标对照（当前观测 vs 历史评估）
      </SettingsText>
      <InfoRow label="当前注入">
        <span className="font-mono">{firedCount}</span>
        <span className="ml-1 text-cafe-muted">次（fired-count·当前查询窗口内）</span>
      </InfoRow>
      {obsCount !== firedCount && (
        <InfoRow label="观测行数">
          <span className="font-mono">{obsCount}</span>
          <span className="ml-1 text-cafe-muted">行（含 observe-only / skipped / disabled，≠ 注入次数）</span>
        </InfoRow>
      )}
      <InfoRow label="查询窗口">
        <span>
          {formatTs(queryWindow.startMs)} ~ {formatTs(queryWindow.endMs)}
          <span className="ml-1 text-cafe-muted">（当前查询窗口，≠ 评估窗口）</span>
        </span>
      </InfoRow>
    </div>
  );
}

/** Eval pending state: per-guard metrics + trigger progress (P1-1 fix). */
function EvalPendingMetrics({
  obsCount,
  firedCount,
  guardMetrics,
}: {
  obsCount: number;
  firedCount: number;
  guardMetrics: GuardMetric[];
}) {
  const totalEvents = guardMetrics.reduce((s, g) => s + g.count, 0);
  const maxCount = guardMetrics.length > 0 ? guardMetrics[0].count : 0;
  const remaining = Math.max(0, EVAL_TRIGGER_THRESHOLD - maxCount);
  const progressPct = Math.min(100, (maxCount / EVAL_TRIGGER_THRESHOLD) * 100);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <InfoRow label="注入次数">
          <span className="font-mono">{firedCount}</span>
          <span className="ml-1 text-cafe-muted">次（fired-count）</span>
        </InfoRow>
        {obsCount !== firedCount && (
          <InfoRow label="观测行数">
            <span className="font-mono">{obsCount}</span>
            <span className="ml-1 text-cafe-muted">行（含 observe-only / skipped / disabled）</span>
          </InfoRow>
        )}
        <InfoRow label="违规事件">
          <span className="font-mono">{totalEvents}</span>
          <span className="ml-1 text-cafe-muted">次（本版本窗口）</span>
        </InfoRow>
        <InfoRow label="触发进度">
          <span className="font-mono">
            {maxCount}/{EVAL_TRIGGER_THRESHOLD}
          </span>
          <span className="ml-1 text-cafe-muted">（单 guard 最高）</span>
        </InfoRow>
      </div>

      {/* Progress bar — tracks single-guard max toward threshold */}
      <div className="rounded-full h-1.5" style={{ backgroundColor: 'var(--console-elevated-bg)' }}>
        <div
          className="rounded-full h-1.5 transition-all"
          style={{
            width: `${progressPct}%`,
            backgroundColor: maxCount >= EVAL_TRIGGER_THRESHOLD ? 'var(--color-amber-500)' : 'var(--color-slate-400)',
          }}
        />
      </div>

      {/* Per-guard breakdown */}
      {guardMetrics.length > 0 && (
        <div className="space-y-0.5">
          <SettingsText as="p" variant="xs" tone="muted" className="font-semibold">
            Guard 分布
          </SettingsText>
          {guardMetrics.map((g) => (
            <div key={g.guardId} className="flex items-center gap-2 text-xs">
              <span className="w-[120px] shrink-0 truncate font-mono text-cafe-muted">{g.guardId}</span>
              <span className="font-mono">
                {g.count}/{EVAL_TRIGGER_THRESHOLD}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Status explanation */}
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        {totalEvents === 0
          ? '零违规事件 — 段运行正常，评估未触发'
          : remaining > 0
            ? `距离自动评估还差 ${remaining} 次违规（同一 guard）`
            : '已达触发阈值，等待评估调度'}
      </SettingsText>

      <InfoRow label="评估方式">
        <span className="text-cafe-muted">{firedCount > 0 ? 'fired-count（注入次数计数）' : '无注入数据'}</span>
      </InfoRow>
      <InfoRow label="上次评估">
        <span className="text-cafe-muted">从未评估</span>
      </InfoRow>
    </div>
  );
}

/** 判定 row: verdict badge + one-line explanation (判据③). Single source of truth = verdict-explanations.ts. */
function VerdictRow({ verdict }: { verdict: string }) {
  const v = explainVerdict(verdict);
  return (
    <>
      <InfoRow label="判定">
        <SettingsBadge tone={v.tone} size="xxs">
          {v.label}
        </SettingsBadge>
      </InfoRow>
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        {v.explanation}
      </SettingsText>
    </>
  );
}

const DENOMINATOR_LABEL: Record<string, string> = {
  'fired-count': 'fired-count（注入次数计数）',
  'session-count': 'session-count（会话计数）',
  none: '无分母（不可计算比率）',
};

/**
 * 判据②: eval sampling window row — the judgment's OWN [startMs,endMs) interval.
 * Legacy cache entries (null/undefined) fail visible: "评估窗口未知" — never
 * derived from evaluatedAt, never substituted with the current query window.
 */
function EvalWindowRow({
  evalWindow,
  gap,
}: {
  evalWindow?: { startMs: number; endMs: number } | null;
  gap?: string | null;
}) {
  return (
    <InfoRow label="评估窗口">
      {evalWindow ? (
        <span>
          {formatTs(evalWindow.startMs)} ~ {formatTs(evalWindow.endMs)}
          <span className="ml-1 text-cafe-muted">（评估采样区间）</span>
        </span>
      ) : gap === 'invalid-present' ? (
        // P2 (sol R5): corrupted provenance — never mislabel as a legacy missing field.
        <span className="text-cafe-muted">评估窗口不可用（缓存数据损坏）</span>
      ) : (
        <span className="text-cafe-muted">评估窗口未知（历史缓存缺字段）</span>
      )}
    </InfoRow>
  );
}

/** 判据②: denominator row — legacy entries fail visible: "分母未知". */
function DenominatorRow({ denominatorKind, gap }: { denominatorKind?: string | null; gap?: string | null }) {
  return (
    <InfoRow label="分母">
      {denominatorKind ? (
        <span className="text-cafe-muted">{DENOMINATOR_LABEL[denominatorKind] ?? denominatorKind}</span>
      ) : gap === 'invalid-present' ? (
        <span className="text-cafe-muted">分母不可用（缓存数据损坏）</span>
      ) : (
        <span className="text-cafe-muted">分母未知（历史缓存缺字段）</span>
      )}
    </InfoRow>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-[80px] shrink-0 text-cafe-muted">{label}</span>
      <span className="text-cafe">{children}</span>
    </div>
  );
}
