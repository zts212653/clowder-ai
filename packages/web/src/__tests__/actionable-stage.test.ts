/**
 * F257 #6 slice 6b (rework per sol R1 + operator option B) — 判据①
 * activeStage / actionableStage UI behavior tests (jsdom render, not source-regex).
 *
 * Original incident (V2 msg 0001784469056616-000054): Console painted the
 * SYNTHESIZED governance.pending (from any alive/dormant verdict) as
 * "待处理 / 需 operator 决策" while no Candidate existed — the exact false
 * signal these tests guard against. 固化 boundary (main msg
 * 0001784469935300-000115): activeStage (real loop stage, unmeasurable →
 * tracing) ≠ actionableStage (real pending Candidate count only).
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GovernanceStagePanel } from '../components/settings/GovernanceStagePanel';
import { LifelineChainView } from '../components/settings/LifelineChainView';
import { LifelineStageDetail } from '../components/settings/LifelineStageDetail';

// ── Fixtures ──────────────────────────────────────────────────

type Verdict = string | null;

function makeEpoch(overrides: {
  version?: number;
  isActive?: boolean;
  verdict?: Verdict;
  governanceDecision?: string | null;
  observations?: number;
}) {
  const { version = 1, isActive = true, verdict = null, governanceDecision = null, observations = 0 } = overrides;
  return {
    version,
    origin: 'manifest',
    startedAt: 0,
    status: 'idle',
    isActive,
    tracing:
      observations > 0
        ? // 判据② P1 (sol R5): fixture observations are fired rows (observe-only
          // semantics covered by eval-window-provenance tests).
          { observationCount: observations, firedCount: observations, firstAt: 1, lastAt: 2 }
        : null,
    eval: verdict ? { verdict, injectionCount: 10, violationCount: 1, evaluatedAt: 1000 } : null,
    governance: governanceDecision ? { decision: governanceDecision, decidedAt: null, actorId: null } : null,
    events: [],
  };
}

const UNAVAILABLE = { stage: null, candidateCount: null, source: 'unavailable' } as const;

function makeEnablementMatrix(): import('@cat-cafe/shared').SegmentEnablementMatrix {
  return {
    segmentId: 'S-x',
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
}

// ── Render harness ────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

/** Find the stage badge button whose text starts with the given label. */
function badge(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label));
  expect(btn, `badge "${label}" rendered`).toBeTruthy();
  return btn as HTMLButtonElement;
}

/** The actionable amber dot is an aria-hidden span inside the badge button. */
function hasActionableDot(btn: HTMLButtonElement): boolean {
  return btn.querySelector('span[aria-hidden="true"]') !== null;
}

// ── 判据① chain view behavior ────────────────────────────────

describe('判据① LifelineChainView — activeStage loop marker', () => {
  it('unmeasurable: loop marker ◈ sits on tracing, NOT governance (active 回 tracing)', async () => {
    const epoch = makeEpoch({ verdict: 'unmeasurable', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'tracing',
        actionable: UNAVAILABLE,
      }),
    );
    expect(badge('tracing').textContent).toContain('◈');
    expect(badge('governance').textContent).not.toContain('◈');
  });

  it('alive: loop marker ◈ sits on governance', async () => {
    const epoch = makeEpoch({ verdict: 'alive', governanceDecision: 'pending', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'governance',
        actionable: UNAVAILABLE,
      }),
    );
    expect(badge('governance').textContent).toContain('◈');
    expect(badge('tracing').textContent).not.toContain('◈');
  });

  it('loop marker only on the ACTIVE epoch (historical epochs unmarked)', async () => {
    const v1 = makeEpoch({ version: 1, isActive: false, verdict: 'alive', governanceDecision: 'pending' });
    const v2 = makeEpoch({ version: 2, isActive: true, observations: 3 });
    await render(
      createElement(LifelineChainView, {
        chain: [v1, v2],
        selected: null,
        onSelect: () => {},
        activeStage: 'tracing',
        actionable: UNAVAILABLE,
      }),
    );
    const tracingBadges = [...container.querySelectorAll('button')].filter((b) => b.textContent?.startsWith('tracing'));
    expect(tracingBadges).toHaveLength(2);
    expect(tracingBadges[0].textContent).not.toContain('◈'); // v1 historical
    expect(tracingBadges[1].textContent).toContain('◈'); // v2 active
  });
});

describe('判据① LifelineChainView — actionable honesty (the incident guard)', () => {
  it('synthesized governance.pending NEVER renders 待处理 or an actionable dot', async () => {
    const epoch = makeEpoch({ verdict: 'alive', governanceDecision: 'pending', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'governance',
        actionable: UNAVAILABLE,
      }),
    );
    const gov = badge('governance');
    expect(container.textContent).not.toContain('待处理');
    expect(hasActionableDot(gov)).toBe(false);
    expect(gov.textContent).not.toContain('待审');
  });

  it('unavailable: governance tooltip honestly says candidate data missing (provenance gap)', async () => {
    const epoch = makeEpoch({ verdict: 'alive', governanceDecision: 'pending', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'governance',
        actionable: UNAVAILABLE,
      }),
    );
    expect(badge('governance').title).toContain('治理候选数据暂不可用');
    expect(badge('governance').title).not.toContain('需 operator 决策');
  });

  it('P2-2: wording is verdict-neutral (评估完成) — dormant must NOT be labeled 评估已通过', async () => {
    const epoch = makeEpoch({ verdict: 'dormant', governanceDecision: 'pending', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'governance',
        actionable: UNAVAILABLE,
      }),
    );
    expect(badge('governance').title).toContain('评估完成');
    expect(container.textContent).not.toContain('评估已通过');
    expect(badge('governance').title).not.toContain('评估已通过');
  });

  it('0 real candidates → no dot, tooltip says 无需动作', async () => {
    const epoch = makeEpoch({ verdict: 'alive', governanceDecision: 'pending', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'governance',
        actionable: { stage: null, candidateCount: 0, source: 'candidate-count' },
      }),
    );
    const gov = badge('governance');
    expect(hasActionableDot(gov)).toBe(false);
    expect(gov.title).toContain('无治理候选（无需动作）');
  });

  it('N=2 real candidates → amber dot + governance(2 待审) label', async () => {
    const epoch = makeEpoch({ verdict: 'alive', governanceDecision: 'pending', observations: 18 });
    await render(
      createElement(LifelineChainView, {
        chain: [epoch],
        selected: null,
        onSelect: () => {},
        activeStage: 'governance',
        actionable: { stage: 'governance', candidateCount: 2, source: 'candidate-count' },
      }),
    );
    const gov = badge('governance');
    expect(hasActionableDot(gov)).toBe(true);
    expect(gov.textContent).toContain('2 待审');
    expect(gov.title).toContain('需 operator 决策');
  });

  it('actionable never leaks onto a NON-active epoch (v1 historical, v2 active)', async () => {
    const v1 = makeEpoch({ version: 1, isActive: false, verdict: 'alive', governanceDecision: 'pending' });
    const v2 = makeEpoch({ version: 2, isActive: true, observations: 3 });
    await render(
      createElement(LifelineChainView, {
        chain: [v1, v2],
        selected: null,
        onSelect: () => {},
        activeStage: 'tracing',
        actionable: { stage: 'governance', candidateCount: 2, source: 'candidate-count' },
      }),
    );
    const govBadges = [...container.querySelectorAll('button')].filter((b) => b.textContent?.startsWith('governance'));
    expect(govBadges).toHaveLength(2);
    expect(hasActionableDot(govBadges[0] as HTMLButtonElement)).toBe(false); // v1 historical
  });
});

describe('判据① R2 P1-4 — the decisive cross-state (active=tracing, actionable=governance N>0)', () => {
  // retire-candidate verdict: loop is back at tracing, epoch.governance is null,
  // yet 2 REAL Candidates await — UI must show them independently of governance.decision.
  const crossEpoch = () => makeEpoch({ verdict: 'retire-candidate', observations: 25 });
  const crossActionable = { stage: 'governance', candidateCount: 2, source: 'candidate-count' } as const;

  it('chain: ◈ on tracing AND governance amber dot + 2 待审 (not gated by governance=null)', async () => {
    await render(
      createElement(LifelineChainView, {
        chain: [crossEpoch()],
        selected: null,
        onSelect: () => {},
        activeStage: 'tracing',
        actionable: crossActionable,
      }),
    );
    expect(badge('tracing').textContent).toContain('◈');
    const gov = badge('governance');
    expect(hasActionableDot(gov)).toBe(true);
    expect(gov.textContent).toContain('2 待审');
    expect(gov.title).toContain('需 operator 决策');
    expect(gov.textContent).not.toContain('◈'); // loop marker stays on tracing
  });

  it('detail panel: shows 2 个候选待审 + CTA — must NOT deny governance items', async () => {
    await render(
      createElement(GovernanceStagePanel, {
        version: 1,
        governance: null,
        guardEvents: [],
        overrideState: null,
        hookId: 'S-x',
        onRefresh: () => {},
        isActiveEpoch: true,
        activeStage: 'tracing',
        actionable: crossActionable,
        enablementMatrix: makeEnablementMatrix(),
      }),
    );
    expect(container.textContent).toContain('2 个候选待审');
    expect(container.textContent).toContain('需 operator 决策');
    expect(container.textContent).not.toContain('未进入治理环节');
    expect(container.textContent).not.toContain('暂无治理事项');
  });
});

// ── 判据① governance detail panel behavior ───────────────────

describe('判据① GovernanceStagePanel — honest pending rendering', () => {
  const baseProps = {
    version: 1,
    guardEvents: [],
    overrideState: null,
    hookId: 'S-x',
    onRefresh: () => {},
    isActiveEpoch: true,
    activeStage: 'governance' as const,
    enablementMatrix: makeEnablementMatrix(),
  };

  it('pending + unavailable → 评估完成 + provenance gap text, NO amber pending badge', async () => {
    await render(
      createElement(GovernanceStagePanel, {
        ...baseProps,
        governance: { decision: 'pending', decidedAt: null, actorId: null },
        actionable: UNAVAILABLE,
      }),
    );
    expect(container.textContent).toContain('评估完成');
    expect(container.textContent).toContain('治理候选数据暂不可用');
    expect(container.textContent).toContain('provenance gap');
    expect(container.textContent).not.toContain('需 operator 决策');
    // P2-2: never 评估已通过 (dormant ≠ pass); no synthesized 待处理 either
    expect(container.textContent).not.toContain('评估已通过');
    expect(container.textContent).not.toContain('待处理');
  });

  it('pending + 2 candidates → amber 2 个候选待审 + 需 operator 决策', async () => {
    await render(
      createElement(GovernanceStagePanel, {
        ...baseProps,
        governance: { decision: 'pending', decidedAt: null, actorId: null },
        actionable: { stage: 'governance', candidateCount: 2, source: 'candidate-count' },
      }),
    );
    expect(container.textContent).toContain('2 个候选待审');
    expect(container.textContent).toContain('需 operator 决策');
  });

  it('pending + 0 candidates → 当前无治理候选（无需动作）', async () => {
    await render(
      createElement(GovernanceStagePanel, {
        ...baseProps,
        governance: { decision: 'pending', decidedAt: null, actorId: null },
        actionable: { stage: null, candidateCount: 0, source: 'candidate-count' },
      }),
    );
    expect(container.textContent).toContain('当前无治理候选（无需动作）');
    expect(container.textContent).not.toContain('需 operator 决策');
  });

  it('no governance yet → 未进入治理环节 (NOT the misleading 等待治理决策)', async () => {
    await render(
      createElement(GovernanceStagePanel, {
        ...baseProps,
        governance: null,
        activeStage: 'tracing',
        actionable: UNAVAILABLE,
      }),
    );
    expect(container.textContent).toContain('未进入治理环节');
    expect(container.textContent).toContain('当前循环位于 tracing');
    expect(container.textContent).not.toContain('等待治理决策');
  });

  it('§16e sweep: epoch status governance-pending renders informational slate, NOT amber 待治理', async () => {
    const epoch = { ...makeEpoch({ verdict: 'dormant', governanceDecision: 'pending' }), status: 'governance-pending' };
    await render(
      createElement(LifelineStageDetail, {
        selected: { version: 1, stage: 'version' },
        chain: [epoch],
        observations: [],
        guardEvents: [],
        epochGuardMetrics: {},
        overrideState: null,
        hookId: 'S-x',
        onRefresh: () => {},
        activeStage: 'governance',
        actionable: UNAVAILABLE,
        enablementMatrix: makeEnablementMatrix(),
      }),
    );
    expect(container.textContent).toContain('评估完成·治理环节');
    expect(container.textContent).not.toContain('待治理');
    expect(container.textContent).not.toContain('评估已通过');
  });

  it('approved still renders approved (unchanged contract)', async () => {
    await render(
      createElement(GovernanceStagePanel, {
        ...baseProps,
        governance: { decision: 'approved', decidedAt: 1720000000000, actorId: 'lang' },
        actionable: UNAVAILABLE,
      }),
    );
    expect(container.textContent).toContain('approved');
  });
});
