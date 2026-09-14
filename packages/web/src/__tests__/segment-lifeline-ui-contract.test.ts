/**
 * F257 Phase D — Segment lifeline UI contract tests.
 *
 * Verifies two non-degradable UI contracts (terra P2-3/P2-4):
 *   1. Guard events section surfaces "窗口关联" / "非因果" attribution
 *   2. Lifeline entry point is a <button> with aria-label, not a <span>
 *
 * Source-structure contracts: read the actual component source and verify
 * the presence of key elements. No jsdom/render needed — these guard
 * against silent regression during refactoring.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_DIR = path.resolve(__dirname, '..', 'components', 'settings');

function readComponent(name: string): string {
  return readFileSync(path.join(SETTINGS_DIR, name), 'utf-8');
}

describe('segment lifeline: guard event attribution (P2-3)', () => {
  // GuardEvent interface is in LifelineStageDetail; rendering moved to GovernanceStagePanel.
  const detailSrc = readComponent('LifelineStageDetail.tsx');
  const govSrc = readComponent('GovernanceStagePanel.tsx');

  it('GuardEvent interface includes attribution field', () => {
    expect(detailSrc).toMatch(/interface\s+GuardEvent[\s\S]*?attribution\??:\s*['"]window-correlated['"]/);
  });

  it('section title contains "窗口关联"', () => {
    expect(govSrc).toContain('窗口关联');
  });

  it('section includes "非因果" disclaimer', () => {
    expect(govSrc).toContain('非因果');
  });
});

describe('segment lifeline: lifecycle event kind labels (AF-5)', () => {
  const uiSrc = readComponent('LifelineStageDetail.tsx');

  // Extract LifecycleEventKind union members from the SHARED type source —
  // not a hand-copied list. If a new kind is added to segment-lifecycle.ts
  // but not to KIND_LABEL, this test fails. (AF-5 root cause: hand-copy drifts.)
  const sharedTypeSrc = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'shared', 'src', 'types', 'segment-lifecycle.ts'),
    'utf-8',
  );
  // Match all single-quoted string literals in the LifecycleEventKind union
  const kindMatches = sharedTypeSrc.match(/export type LifecycleEventKind[\s\S]*?;/);
  const kinds = kindMatches ? [...kindMatches[0].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

  it('shared type has LifecycleEventKind members (test sanity)', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(8);
  });

  it('KIND_LABEL covers every LifecycleEventKind from shared types', () => {
    for (const kind of kinds) {
      expect(uiSrc).toContain(`'${kind}'`);
    }
  });

  it('governance-reject has Chinese label (not raw enum)', () => {
    expect(uiSrc).toMatch(/'governance-reject':\s*'[^']+'/);
  });
});

describe('segment lifeline: eval pending metrics panel (AC补遗)', () => {
  const evalSrc = readComponent('EvalStagePanel.tsx');

  it('EvalStagePanel shows observation count in pending state', () => {
    // 判据② P1 (sol R5): the pending panel now separates the REAL fired-count
    // metric from raw observation rows (observe-only rows are not injections) —
    // the old single '观测次数 … 次注入' row encoded exactly that mislabel.
    expect(evalSrc).toContain('注入次数');
    expect(evalSrc).toContain('观测行数');
  });

  it('EvalStagePanel shows guard event count in pending state', () => {
    expect(evalSrc).toContain('违规事件');
  });

  it('EvalStagePanel shows trigger progress toward threshold', () => {
    expect(evalSrc).toContain('触发进度');
    expect(evalSrc).toContain('EVAL_TRIGGER_THRESHOLD');
  });

  it('EvalStagePanel shows eval method (fired-count)', () => {
    expect(evalSrc).toContain('fired-count');
  });

  it('EvalStagePanel explains zero-violation state', () => {
    expect(evalSrc).toContain('零违规事件');
  });

  it('EvalStagePanel has progress bar for trigger threshold', () => {
    expect(evalSrc).toContain('progressPct');
  });
});

describe('segment lifeline: version operation buttons (①)', () => {
  const detailSrc = readComponent('LifelineStageDetail.tsx');
  const actionsSrc = readComponent('VersionActions.tsx');

  it('LifelineStageDetail imports action button components', () => {
    expect(detailSrc).toContain('ActivateVersionButton');
    expect(detailSrc).not.toContain('RollbackButton');
    // ToggleOverrideButton moved to GovernanceStagePanel (extraction)
    const govSrc = readComponent('GovernanceStagePanel.tsx');
    expect(govSrc).toContain('ToggleOverrideButton');
  });

  it('VersionActions calls prompt-hooks API endpoints', () => {
    expect(actionsSrc).toContain('/api/prompt-hooks/');
    expect(actionsSrc).toContain('/versions/activate');
    expect(actionsSrc).toContain('/override');
  });

  it('VersionActions requires reason for audit trail', () => {
    expect(actionsSrc).toContain('审计追踪');
    expect(actionsSrc).toContain('reason');
  });

  it('destructive actions have confirmation', () => {
    expect(actionsSrc).toContain('window.confirm');
  });

  it('LifelineStageDetail accepts hookId and onRefresh props', () => {
    expect(detailSrc).toContain('hookId: string');
    expect(detailSrc).toContain('onRefresh: () => void');
  });
});

describe('segment lifeline: tracing row drill-down (②)', () => {
  const src = readComponent('LifelineStageDetail.tsx');

  it('ObservationRow is expandable (has useState toggle)', () => {
    expect(src).toContain('useState');
    expect(src).toMatch(/setExpanded/);
  });

  it('expanded row shows threadId and turnId', () => {
    expect(src).toContain('obs.threadId');
    expect(src).toContain('obs.turnId');
  });

  it('expand indicator shows ▸/▾ chevron', () => {
    expect(src).toContain('▾');
    expect(src).toContain('▸');
  });
});

describe('segment lifeline: shared type contract — guard projection', () => {
  const sharedSrc = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'shared', 'src', 'types', 'segment-lifecycle.ts'),
    'utf-8',
  );

  it('SegmentLifecycleResponse publishes no guard projection', () => {
    // The summary response used to carry window-correlated guard events and a
    // per-epoch attribution of them. No console surface read either one, and
    // producing them cost an unfenced cross-owner scan on every request. Guard
    // evidence is served per event by the owner-fenced replay route instead.
    const summaryContract = sharedSrc.slice(
      sharedSrc.indexOf('interface SegmentLifecycleResponse'),
      sharedSrc.indexOf('判据④'),
    );
    expect(summaryContract).not.toMatch(/epochGuardMetrics/);
    expect(summaryContract).not.toMatch(/guardEvents/);
  });

  it('GuardMetric interface is defined with guardId and count', () => {
    expect(sharedSrc).toMatch(/export interface GuardMetric/);
    expect(sharedSrc).toContain('guardId: string');
    expect(sharedSrc).toContain('count: number');
  });
});

describe('segment lifeline: GuardMetric consumption uses shared import (R17 P2-1)', () => {
  const evalSrc = readComponent('EvalStagePanel.tsx');
  const detailSrc = readComponent('LifelineStageDetail.tsx');

  it('EvalStagePanel imports GuardMetric from @cat-cafe/shared', () => {
    expect(evalSrc).toMatch(/import\s+type\s*\{[^}]*GuardMetric[^}]*\}\s*from\s*'@cat-cafe\/shared'/);
  });

  it('EvalStagePanel does NOT define local GuardMetric interface', () => {
    expect(evalSrc).not.toMatch(/interface\s+GuardMetric\s*\{/);
  });

  it('LifelineStageDetail imports GuardMetric from @cat-cafe/shared', () => {
    expect(detailSrc).toMatch(/import\s+type\s*\{[^}]*GuardMetric[^}]*\}\s*from\s*'@cat-cafe\/shared'/);
  });

  it('LifelineStageDetail uses GuardMetric[] not inline mirror', () => {
    expect(detailSrc).toContain('GuardMetric[]');
    expect(detailSrc).not.toMatch(/epochGuardMetrics:\s*Record<number,\s*Array<\{/);
  });
});

describe('segment lifeline: eval per-guard metrics (R14 P1-1, R15 P1)', () => {
  const evalSrc = readComponent('EvalStagePanel.tsx');
  const detailSrc = readComponent('LifelineStageDetail.tsx');

  it('EvalStagePanel uses guardMetrics prop (not global guardEventCount)', () => {
    expect(evalSrc).toContain('guardMetrics');
    expect(evalSrc).not.toContain('guardEventCount');
  });

  it('EvalStagePanel shows per-guard breakdown', () => {
    expect(evalSrc).toContain('guardId');
    expect(evalSrc).toContain('Guard 分布');
  });

  it('EvalStagePanel tracks single-guard max for trigger progress', () => {
    expect(evalSrc).toContain('maxCount');
    expect(evalSrc).toContain('单 guard 最高');
  });

  it('LifelineStageDetail takes epochGuardMetrics as a prop rather than computing it', () => {
    expect(detailSrc).toContain('epochGuardMetrics');
    expect(detailSrc).not.toContain('computeEpochGuardMetrics');
  });

  it('EvalStagePanel shows "无注入数据" when obsCount is zero', () => {
    expect(evalSrc).toContain('无注入数据');
  });
});

describe('segment lifeline: v1 activate guard (R14 P1-3)', () => {
  const src = readComponent('LifelineStageDetail.tsx');
  const actionsSrc = readComponent('VersionActions.tsx');

  it('routes every inactive version through one cycle-aware activation action', () => {
    expect(src).toMatch(/!epoch\.isActive && \([\s\S]*?ActivateVersionButton/);
    expect(actionsSrc).toContain('epochVersion === 1 ? runtime.actions.rollback : runtime.actions.activateVersion');
    expect(src).not.toContain('RollbackButton');
  });
});

describe('segment lifeline: null overrideState handling (R14 P1-4)', () => {
  const govSrc = readComponent('GovernanceStagePanel.tsx');

  it('derives effectiveEnabled from null overrideState', () => {
    expect(govSrc).toContain('overrideState?.enabled ?? true');
  });

  it('always renders ToggleOverrideButton with derived effectiveEnabled', () => {
    // ToggleOverrideButton must use effectiveEnabled (not gated by overrideState presence)
    expect(govSrc).toContain('ToggleOverrideButton');
    expect(govSrc).toContain('currentlyEnabled={effectiveEnabled}');
  });

  it('shows default indicator when no override record exists', () => {
    expect(govSrc).toContain('（默认）');
  });
});

describe('segment lifeline: cancel aborts mutation (R14 P2-1)', () => {
  const src = readComponent('VersionActions.tsx');

  it('null prompt (Cancel) returns null without API call', () => {
    expect(src).toContain('reason == null');
    expect(src).toContain('Promise.resolve(null)');
  });

  it('empty reason also aborts (trim check)', () => {
    expect(src).toMatch(/reason\.trim\(\)\s*===\s*''/);
  });

  it('ActionButton handles null return from action (no mutation)', () => {
    expect(src).toContain('if (!res) return');
  });
});

describe('segment lifeline: a11y entry point (P2-4)', () => {
  const src = readComponent('StageDetailPanels.tsx');

  it('lifeline trigger is a <button>, not a <span>', () => {
    // The 📊 trigger must be a semantic button for keyboard/screen-reader access
    expect(src).toMatch(/<button[\s\S]*?📊[\s\S]*?<\/button>/);
    // Must NOT have a clickable span with the chart emoji
    expect(src).not.toMatch(/<span[^>]*onClick[\s\S]*?📊[\s\S]*?<\/span>/);
  });

  it('lifeline button has aria-label', () => {
    // The button must have an accessible name describing the action
    expect(src).toMatch(/<button[\s\S]*?aria-label=/);
    expect(src).toContain('评估与回放');
  });

  it('lifeline button has type="button"', () => {
    // Explicit type prevents accidental form submission
    expect(src).toMatch(/<button[\s\S]*?type="button"/);
  });
});

describe('F257 versioned editor and supplemental segment presentation', () => {
  const rowsSrc = readComponent('StageDetailPanels.tsx');
  const editorSrc = `${readComponent('SegmentEditorModal.tsx')}\n${readComponent('useVersionedSegmentEditor.ts')}`;
  const formatSrc = readComponent('SegmentFormatModal.tsx');

  it('removes obsolete per-segment mode badges and lifecycle entry points from supplemental rows', () => {
    expect(rowsSrc).not.toContain('resolveSegmentTags');
    expect(rowsSrc).not.toContain("label: '只读'");
    expect(rowsSrc).toContain("s.sourceType === 'template'");
    expect(rowsSrc).toContain('SegmentFormatModal');
    expect(formatSrc).toContain('格式示例');
    for (const id of ['M1', 'M2', 'N2']) expect(formatSrc).toContain(`${id}:`);
  });

  it('edits an explicit version baseline and creates one applied lifecycle version', () => {
    expect(editorSrc).toContain('/api/segment-lifeline/');
    expect(editorSrc).toContain('/versions/');
    expect(editorSrc).toContain('baseVersion');
    expect(editorSrc).toContain('expectedActiveVersion');
    expect(editorSrc).toContain('产生并应用新版本');
    expect(editorSrc).not.toContain("method: 'PUT'");
  });
});

describe('segment evaluation: objective metrics and trace replay are the modal truth (F257 redesign)', () => {
  const modalSrc = readComponent('SegmentLifelineModal.tsx');
  const versionContentSrc = readComponent('VersionContentPreview.tsx');
  const evaluationSrc = readComponent('ObjectiveEvaluationPanel.tsx');
  const governanceSrc = readComponent('ObjectiveGovernancePanel.tsx');
  const theaterSrc = readComponent('SegmentTraceTheater.tsx');

  it('loads the objective evaluation read model alongside neutral tracing', () => {
    expect(modalSrc).toContain('/api/segment-evaluation/');
    expect(modalSrc).toContain('/api/segment-lifeline/');
    expect(modalSrc).toContain('ObjectiveEvaluationPanel');
    expect(modalSrc).toContain('ObjectiveGovernancePanel');
    expect(modalSrc).toContain('SegmentTraceTheater');
  });

  it('keeps the version lifecycle as the navigation coordinate', () => {
    expect(modalSrc).toContain('LifelineChainView');
    expect(modalSrc).toContain("selected?.stage === 'tracing'");
    expect(modalSrc).toContain("selected?.stage === 'eval'");
    expect(modalSrc).not.toContain("type View = 'metrics' | 'tracing'");
    expect(modalSrc).not.toContain('段评估视图');
  });

  it('loads exact content when a version node is selected', () => {
    expect(modalSrc).toContain('VersionContentPreview');
    expect(versionContentSrc).toContain('/api/prompt-injection/segment/');
    expect(versionContentSrc).toMatch(/\/versions\/\$\{epoch\.version\}\/content/);
  });

  it('makes selected lifecycle nodes visually and semantically explicit', () => {
    const chainSrc = readComponent('LifelineChainView.tsx');
    expect(chainSrc).toContain('aria-pressed={selected}');
    expect(chainSrc).toContain("'aria-current': current ? ('step' as const) : undefined");
    expect(chainSrc).toContain('!bg-cafe-accent');
    expect(chainSrc).toContain('!text-[var(--cafe-accent-foreground)]');
    expect(chainSrc).not.toContain('outline-2');
    expect(chainSrc).not.toContain('--console-active-ring');
  });

  it('shows the operator-facing metric contract', () => {
    for (const label of ['归属', '评估模型', '指标目录', '方向', '含义', '评估方式', '评估规则']) {
      expect(evaluationSrc).toContain(label);
    }
    expect(evaluationSrc).toContain('selectedCycle?.evalStatus');
    expect(evaluationSrc).toContain('latestEvaluation');
    expect(evaluationSrc).toContain('latestConclusion');
    expect(evaluationSrc).toContain('检测覆盖');
    expect(evaluationSrc).toContain('coverageAssessment');
    expect(evaluationSrc).toContain('coverageFindingLabel');
    expect(evaluationSrc).toContain('检测器缺口');
    expect(evaluationSrc).toContain('现在要做');
    expect(evaluationSrc).toContain('下次看什么');
    expect(evaluationSrc).toContain('openInvocationTrajectory');
    expect(evaluationSrc).not.toContain('latestJudgment');
    expect(evaluationSrc).not.toContain('MetricResult');
  });

  it('shows governance for the selected CycleRecord without duplicating the top lifecycle chain', () => {
    for (const field of ['latestGovernance', 'decision', 'approval', 'selectedCycle', 'governance.by']) {
      expect(governanceSrc).toContain(field);
    }
    expect(governanceSrc).not.toContain('版本链');
    expect(governanceSrc).toContain('决策者');
    expect(modalSrc).not.toContain('EvalSourceWarning');
  });

  it('renders Unit readiness and structured counterexamples in tracing, not per metric', () => {
    // Top grid: trigger rules with live progress + cycle start
    for (const label of ['触发条件', '周期起点']) {
      expect(theaterSrc).toContain(label);
    }
    // "版本起点" replaced by "周期起点"
    expect(theaterSrc).not.toContain('版本起点');
    expect(theaterSrc).toContain('structuredCounterexamples');
    // Trigger shows live progress against thresholds so the 200/3 rules map to
    // the visible group counts (co-creator 2026-08-26: the relation must be legible)
    expect(theaterSrc).toContain('objective.cumulative.count');
    expect(theaterSrc).toContain('objective.cumulative.threshold');
    expect(theaterSrc).toContain('objective.counterexamples.count');
    expect(theaterSrc).toContain('objective.counterexamples.threshold');
    expect(theaterSrc).toContain('objective.cadence.elapsedMs');
    expect(theaterSrc).toContain('objective.cadence.thresholdMs');
    expect(theaterSrc).toContain('objective.triggeredBy');
    expect(theaterSrc).toContain('满足任一条件触发');
    // co-creator 2026-08-26: exactly two groups — structured counterexamples +
    // windowed cumulative tracing; the owner-wide unclassified count is removed
    // from the segment view (it never participates in this Unit's trigger).
    expect(theaterSrc).toContain('周期内反例Tracing');
    expect(theaterSrc).toContain('周期累计Tracing');
    expect(theaterSrc).toContain('周期反例Tracing');
    expect(theaterSrc).toContain('最大累计时间窗');
    expect(theaterSrc).toContain('周期内注入Tracing');
    expect(theaterSrc).toContain('segment.injectionCount');
    expect(theaterSrc).toContain('segment.disabledCount');
    expect(theaterSrc).not.toContain('本段查询窗');
    expect(theaterSrc).not.toContain('本段注入明细');
    expect(theaterSrc).toContain('周期内暂无明确反例；Tracing 仍持续累计');
    expect(theaterSrc).not.toContain('时间窗内累计 Tracing');
    expect(theaterSrc).not.toContain('待分类');
    expect(theaterSrc).not.toContain('unclassifiedEpisodeCount');
    expect(theaterSrc).not.toContain('原始 Tracing 记录');
    // Cycle start uses the CycleRecord-backed sole Objective start.
    expect(theaterSrc).toContain('trigger.objective.cycleStartMs');
    expect(theaterSrc).not.toContain('采集故障：owner 线性池在本周期内没有 Tracing');
    expect(theaterSrc).not.toContain('objective.policyChangeCount > 0');
    expect(theaterSrc).toContain('最短采集评估时间');
    expect(theaterSrc).toContain("objective.evalStatus !== 'idle'");
    expect(theaterSrc).toContain("objective.lifecycle !== 'active'");
    expect(theaterSrc).toContain('评估停滞');
    expect(theaterSrc).toContain('已休眠');
    expect(theaterSrc).not.toContain('Tracing 明细（{total}）');
    // F257 R6: must use toLocaleString (with time) not toLocaleDateString (date-only)
    expect(theaterSrc).toContain('toLocaleString()');
    expect(theaterSrc).not.toContain('toLocaleDateString()');
  });

  it('opens complete TraceEpisode scenes only after selecting a version tracing stage', () => {
    expect(modalSrc).toContain("selected?.stage === 'tracing'");
    expect(modalSrc).toContain('versionObservations');
    expect(theaterSrc).not.toContain('点击记录查看完整现场');
    expect(theaterSrc).not.toContain('Tracing 回放剧场');
    expect(theaterSrc).not.toContain('每一场都是完整 TraceEpisode');
    expect(theaterSrc).toContain('SegmentReplayPanel');
    expect(theaterSrc).not.toContain('Thread:');
    expect(theaterSrc).not.toContain('Turn:');
  });

  it('does not expose internal metric slugs as operator-facing content', () => {
    expect(evaluationSrc).not.toContain('ml-auto font-mono text-micro text-cafe-muted');
  });
});
