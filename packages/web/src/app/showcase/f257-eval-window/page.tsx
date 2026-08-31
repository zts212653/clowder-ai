'use client';

/**
 * F257 #6 slice 6c — 判据② eval window / denominator provenance showcase.
 *
 * Review harness (sol R1 P2-2 / R2 P1-2): reproduces the original 18-vs-0
 * incident in ONE composed viewport — chain badge `tracing(18)` + eval detail
 * showing both coordinates side by side:
 *   - current tracing: observationCount=18 within the CURRENT query window
 *   - historical eval: injectionCount=0 within the judgment's OWN eval window
 *
 * The fixture is producer-reachable ONLY (sol R2 P1-2): injectionCount=0 →
 * verdict 'unmeasurable' + denominatorKind 'none' (segment-judgment-engine
 * produceVerdict), cycle back at tracing (6b loop model), no governance.
 *
 * Replay:
 *   pnpm --dir packages/web build && pnpm --dir packages/web start -- -p 3210
 *   open http://localhost:3210/showcase/f257-eval-window
 * Capture evidence with local browser tooling (Browser skill / playwright);
 * keep capture output OUTSIDE the worktree (clean-worktree gate, sol R2 P2-4).
 */

import { useState } from 'react';
import { LifelineChainView, type SelectedStage } from '@/components/settings/LifelineChainView';
import { LifelineStageDetail } from '@/components/settings/LifelineStageDetail';

/** The judgment's OWN historical eval window (1d window, ~10 days before the query window). */
const EVAL_WINDOW = { startMs: 1_752_076_800_000, endMs: 1_752_163_200_000 };
/** The CURRENT lifeline query window (last 7d — a different coordinate). */
const QUERY_WINDOW = { startMs: 1_753_171_200_000, endMs: 1_753_776_000_000 };

const epoch = {
  version: 1,
  origin: 'manifest',
  startedAt: EVAL_WINDOW.startMs - 86_400_000,
  // unmeasurable → cycle returns to tracing (6b loop model): eval-pending, no governance.
  status: 'eval-pending',
  isActive: true,
  tracing: {
    observationCount: 18,
    firedCount: 18,
    firstAt: QUERY_WINDOW.startMs + 3_600_000,
    lastAt: QUERY_WINDOW.endMs - 3_600_000,
  },
  eval: {
    // Producer-reachable ONLY (sol R2 P1-2): injectionCount=0 → unmeasurable + none.
    verdict: 'unmeasurable',
    injectionCount: 0,
    violationCount: 0,
    evaluatedAt: EVAL_WINDOW.endMs,
    evalWindow: EVAL_WINDOW,
    denominatorKind: 'none',
  },
  governance: null,
  events: [],
};

const legacyEpoch = {
  ...epoch,
  version: 2,
  isActive: false,
  eval: {
    // Legacy pre-6c cache entry: the JUDGMENT was producer-valid (alive,
    // injectionCount>0) but the provenance fields are missing → fail-visible.
    verdict: 'alive',
    injectionCount: 2,
    violationCount: 0,
    evaluatedAt: EVAL_WINDOW.endMs,
    evalWindow: null,
    denominatorKind: null,
  },
};

const noop = () => {};
const UNACTIONABLE = { stage: null, candidateCount: null, source: 'unavailable' } as const;

const enablementMatrix: import('@cat-cafe/shared').SegmentEnablementMatrix = {
  segmentId: 'S-showcase-eval-window',
  safetyTier: 'editable',
  allowLocalOverride: true,
  disableable: true,
  localOverlay: {
    hasOverlay: false,
    hasBackup: false,
    actions: {
      edit: { allowed: true, reason: null, reasonCode: null },
      restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
      reset: { allowed: false, reason: '当前段无本地覆盖可重置', reasonCode: 'no-local-overlay' },
    },
  },
  runtimeOverride: {
    enabled: true,
    hasOverride: false,
    hasContentOverride: false,
    hasVersionSnapshot: false,
    availableEpochVersions: [],
    actions: {
      disable: { allowed: true, reason: null, reasonCode: null },
      enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
      rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
      activateVersion: { allowed: false, reason: '当前段无保留版本可激活', reasonCode: 'no-version-snapshot' },
    },
  },
};

export default function ShowcaseF257EvalWindow() {
  const [selected, setSelected] = useState<SelectedStage>({ version: 1, stage: 'eval' });

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold">F257 判据② — eval window / denominator provenance（18 vs 0 事故回归）</h1>
        <p className="mt-2 text-sm text-cafe-secondary">
          同一 viewport 必须一眼可见两套坐标：链上 <code className="font-mono">tracing(18)</code> 来自
          <strong>当前查询窗口</strong>；eval 详情 <code className="font-mono">injectionCount=0</code> 来自
          <strong>该 judgment 自己的历史评估窗口</strong>（unmeasurable · 无分母）。
        </p>
      </div>

      {/* Case 1: the incident — 18 vs 0 in ONE viewport */}
      <section className="rounded-2xl bg-[var(--console-card-bg)] p-[26px]">
        <h2 className="mb-3 text-sm font-semibold text-cafe">Case 1 — 事故现场：tracing(18) vs eval(0)，双坐标同屏</h2>
        <div className="space-y-4">
          <LifelineChainView
            chain={[epoch]}
            selected={selected}
            onSelect={setSelected}
            activeStage="tracing"
            actionable={UNACTIONABLE}
          />
          <LifelineStageDetail
            selected={selected}
            chain={[epoch]}
            observations={[]}
            guardEvents={[]}
            epochGuardMetrics={{ 1: [] }}
            overrideState={null}
            hookId="S-showcase-eval-window"
            onRefresh={noop}
            activeStage="tracing"
            actionable={UNACTIONABLE}
            queryWindow={QUERY_WINDOW}
            enablementMatrix={enablementMatrix}
          />
        </div>
      </section>

      {/* Case 2: legacy cache entry — fail-visible unknown, never guessed */}
      <section className="rounded-2xl bg-[var(--console-card-bg)] p-[26px]">
        <h2 className="mb-3 text-sm font-semibold text-cafe">
          Case 2 — legacy 缓存（缺 window/denominator）→ fail-visible 未知
        </h2>
        <LifelineStageDetail
          selected={{ version: 2, stage: 'eval' }}
          chain={[legacyEpoch]}
          observations={[]}
          guardEvents={[]}
          epochGuardMetrics={{ 2: [] }}
          overrideState={null}
          hookId="S-showcase-eval-window"
          onRefresh={noop}
          activeStage="tracing"
          actionable={UNACTIONABLE}
          queryWindow={QUERY_WINDOW}
          enablementMatrix={enablementMatrix}
        />
      </section>
    </div>
  );
}
