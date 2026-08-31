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
    expect(detailSrc).toContain('RollbackButton');
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

describe('segment lifeline: shared type contract — epochGuardMetrics (R16 P2-1)', () => {
  const sharedSrc = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'shared', 'src', 'types', 'segment-lifecycle.ts'),
    'utf-8',
  );

  it('SegmentLifecycleResponse includes epochGuardMetrics field', () => {
    expect(sharedSrc).toMatch(/epochGuardMetrics:\s*Record<number,\s*GuardMetric\[\]>/);
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

  it('R15: LifelineStageDetail uses API-provided epochGuardMetrics (not local computation)', () => {
    expect(detailSrc).toContain('epochGuardMetrics');
    expect(detailSrc).not.toContain('computeEpochGuardMetrics');
  });

  it('EvalStagePanel shows "无注入数据" when obsCount is zero', () => {
    expect(evalSrc).toContain('无注入数据');
  });
});

describe('segment lifeline: v1 activate guard (R14 P1-3)', () => {
  const src = readComponent('LifelineStageDetail.tsx');

  it('ActivateVersionButton only for version > 1', () => {
    expect(src).toContain('epoch.version > 1');
    expect(src).toMatch(/!epoch\.isActive && epoch\.version > 1/);
  });

  it('v1 shows RollbackButton instead of ActivateVersionButton', () => {
    expect(src).toContain('epoch.version === 1');
    expect(src).toMatch(/epoch\.version === 1[\s\S]*?RollbackButton/);
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

describe('segment lifeline: create version form (R15 P1)', () => {
  const formSrc = readComponent('CreateVersionForm.tsx');
  const detailSrc = readComponent('LifelineStageDetail.tsx');

  it('CreateVersionForm calls POST /versions endpoint', () => {
    expect(formSrc).toContain('/api/prompt-hooks/');
    expect(formSrc).toContain('/versions');
    expect(formSrc).toContain("method: 'POST'");
  });

  it('CreateVersionForm has content textarea and reason input', () => {
    expect(formSrc).toContain('textarea');
    expect(formSrc).toContain('cv-content');
    expect(formSrc).toContain('cv-reason');
  });

  it('CreateVersionForm sends content and reason in body', () => {
    expect(formSrc).toContain('content: content.trim()');
    expect(formSrc).toContain('reason: reason.trim()');
  });

  it('CreateVersionForm requires non-empty content and reason', () => {
    expect(formSrc).toContain('!content.trim() || !reason.trim()');
  });

  it('LifelineStageDetail shows CreateVersionForm for active epoch', () => {
    expect(detailSrc).toContain('CreateVersionForm');
    expect(detailSrc).toContain('epoch.isActive');
  });

  it('CreateVersionForm has cancel button that resets state', () => {
    expect(formSrc).toContain('handleCancel');
    expect(formSrc).toContain('取消');
  });

  it('CreateVersionForm has audit trail label', () => {
    expect(formSrc).toContain('审计追踪');
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

describe('segment evaluation: objective metrics and trace replay are the modal truth (F257 redesign)', () => {
  const modalSrc = readComponent('SegmentLifelineModal.tsx');
  const evaluationSrc = readComponent('ObjectiveEvaluationPanel.tsx');
  const theaterSrc = readComponent('SegmentTraceTheater.tsx');

  it('loads the objective evaluation read model alongside neutral tracing', () => {
    expect(modalSrc).toContain('/api/segment-evaluation/');
    expect(modalSrc).toContain('/api/segment-lifeline/');
    expect(modalSrc).toContain('ObjectiveEvaluationPanel');
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
    expect(modalSrc).toContain('/api/prompt-injection/segment/');
    expect(modalSrc).toContain('/versions/${epoch.version}/content');
  });

  it('makes selected lifecycle nodes visually and semantically explicit', () => {
    const chainSrc = readComponent('LifelineChainView.tsx');
    expect(chainSrc).toContain('aria-pressed={active}');
    expect(chainSrc).toContain('!bg-cafe-accent');
    expect(chainSrc).toContain('!text-[var(--cafe-accent-foreground)]');
    expect(chainSrc).not.toContain('outline-2');
    expect(chainSrc).not.toContain('--console-active-ring');
  });

  it('shows the operator-facing metric contract', () => {
    for (const label of ['归属', '评估模型', '评估方式', '评估规则', '评估时间', '评估窗口']) {
      expect(evaluationSrc).toContain(label);
    }
    expect(evaluationSrc).not.toContain('触发条件');
    expect(evaluationSrc).not.toContain('下一次触发');
  });

  it('renders Unit readiness and structured counterexamples in tracing, not per metric', () => {
    // Top grid: static trigger rules + cycle start + unclassified count
    for (const label of ['触发条件', '周期起点', '待分类']) {
      expect(theaterSrc).toContain(label);
    }
    // "版本起点" replaced by "周期起点"; live counts removed from top grid
    expect(theaterSrc).not.toContain('版本起点');
    expect(theaterSrc).toContain('structuredCounterexamples');
    // Trigger shows static rules (traceRequired, counterexampleRequired), not live counts
    expect(theaterSrc).toContain('traceRequired');
    expect(theaterSrc).toContain('counterexampleRequired');
    expect(theaterSrc).toContain('满足任一条件即触发');
    // F257 P2-2: unclassified episode count surfaced in top grid
    expect(theaterSrc).toContain('unclassifiedEpisodeCount');
    // Cycle start uses perObjective windowStartMs
    expect(theaterSrc).toContain('po.windowStartMs');
    // F257 R6: must use toLocaleString (with time) not toLocaleDateString (date-only)
    expect(theaterSrc).toContain('toLocaleString()');
    expect(theaterSrc).not.toContain('toLocaleDateString()');
  });

  it('opens complete TraceEpisode scenes only after selecting a version tracing stage', () => {
    expect(modalSrc).toContain("selected?.stage === 'tracing'");
    expect(modalSrc).toContain('versionObservations');
    expect(theaterSrc).toContain('点击记录查看完整现场');
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
