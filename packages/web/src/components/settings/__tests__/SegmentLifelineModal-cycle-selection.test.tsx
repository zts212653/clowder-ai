// @vitest-environment jsdom

import type { SegmentCycleSummary, SegmentEvaluationResponse, SegmentLifecycleResponse } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectiveEvaluationPanel } from '../ObjectiveEvaluationPanel';
import { ObjectiveGovernancePanel } from '../ObjectiveGovernancePanel';
import { SegmentLifelineModal } from '../SegmentLifelineModal';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const prior: SegmentCycleSummary = {
  cycleId: 'cycle-prior',
  segmentVersion: 1,
  version: 'objective-v1',
  versionContentRef: 'objective:test@v1',
  cycleStart: 100,
  cycleEnd: 200,
  evalStatus: 'written',
  windows: [{ start: 100, end: 200 }],
  triggeredBy: ['cumulative'],
  evaluation: { overall: 'complete', writtenAt: 210, by: 'evaluator' },
  governance: { decision: 'keep', reason: '历史周期保持', writtenAt: 220, by: 'evaluator' },
  governanceImpact: null,
  approval: null,
  rejectReasons: [],
  termination: null,
  closedAt: 220,
};

const current: SegmentCycleSummary = {
  ...prior,
  cycleId: 'cycle-current',
  cycleStart: 200,
  cycleEnd: null,
  evalStatus: 'idle',
  windows: [],
  triggeredBy: [],
  evaluation: null,
  governance: null,
  closedAt: null,
};

const lifeline: SegmentLifecycleResponse = {
  segmentId: 'D1',
  segmentName: '身份锚定',
  activeVersion: 1,
  versionActivations: [{ timestamp: 0, version: 1 }],
  currentStatus: 'tracing',
  window: { startMs: 0, endMs: 400 },
  observations: [],
  observationsCapped: false,
  overrideState: null,
  enablementMatrix: {
    segmentId: 'D1',
    safetyTier: 'readonly',
    allowLocalOverride: false,
    disableable: false,
    localOverlay: {
      hasOverlay: false,
      hasBackup: false,
      actions: {
        edit: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
        restoreBackup: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
        reset: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
      },
    },
    runtimeOverride: {
      enabled: true,
      hasOverride: false,
      hasContentOverride: false,
      hasVersionSnapshot: false,
      availableEpochVersions: [],
      actions: {
        disable: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
        enable: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
        rollback: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
        activateVersion: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
        createVersion: { allowed: false, reason: 'readonly', reasonCode: 'readonly' },
      },
    },
  },
  chain: [
    {
      version: 1,
      parentVersion: null,
      origin: 'manifest',
      startedAt: 0,
      status: 'tracing',
      isActive: true,
      tracing: null,
      eval: null,
      governance: null,
      events: [],
    },
  ],
};

function evaluationFor(selected: SegmentCycleSummary): SegmentEvaluationResponse {
  const isPrior = selected.cycleId === prior.cycleId;
  return {
    segmentId: 'D1',
    window: { start: selected.cycleStart, end: selected.cycleEnd ?? 400 },
    tracing: {
      trigger: {
        objective: {
          objectiveId: 'identity-truth',
          lifecycle: 'active',
          health: 'healthy',
          policyChangeCount: 0,
          evalStatus: selected.evalStatus,
          cycleStartMs: selected.cycleStart,
          cycleEndMs: selected.cycleEnd,
          lastClosedAtMs: isPrior ? null : prior.closedAt,
          minimumIntervalMs: 7_200_000,
          triggeredBy: selected.triggeredBy,
          cumulative: { count: isPrior ? 200 : 26, threshold: 300 },
          counterexamples: { count: 0, threshold: 3 },
          cadence: { elapsedMs: 100, thresholdMs: 604_800_000, eligible: true },
        },
        segment: { segmentId: 'D1', observationCount: 0, injectionCount: 0, disabledCount: 0 },
      },
      injections: [],
      injectionsCapped: false,
      structuredCounterexamples: [],
    },
    objectives: [
      {
        objectiveId: 'identity-truth',
        objectiveLabel: '身份真相',
        objectiveStatement: '身份信息必须准确',
        evaluationModelId: 'em-identity',
        evaluationModelLabel: '身份评估',
        ruleVersion: 'v1',
        unitRefs: [{ unitType: 'segment', unitId: 'D1' }],
        metrics: [
          {
            metricId: 'identity-error-count',
            label: '身份错误',
            kind: 'counter',
            evaluatorKind: 'code',
            evaluatorRuleRef: 'identity-error',
            verdictRule: { kind: 'counter-zero' },
            latestConclusion: isPrior ? { kind: 'count', value: 0, howCounted: '历史周期结论' } : null,
            evidenceRefs: [],
          },
        ],
        selectedCycle: selected,
        currentCycle: current,
        latestEvaluation: isPrior
          ? { cycleId: prior.cycleId, overall: 'complete', writtenAt: 210, by: 'evaluator', windows: prior.windows }
          : null,
        latestGovernance: isPrior
          ? {
              cycleId: prior.cycleId,
              decision: 'keep',
              reason: '历史周期保持',
              writtenAt: 220,
              by: 'evaluator',
              approval: null,
              impact: null,
            }
          : null,
        versionChain: [prior, current],
        versionChainCapped: false,
      },
    ],
  };
}

describe('SegmentLifelineModal cycle selection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/segment-lifeline/D1') return { ok: true, json: async () => lifeline };
      if (url.includes('cycleId=cycle-prior')) return { ok: true, json: async () => evaluationFor(prior) };
      return { ok: true, json: async () => evaluationFor(current) };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('loads exact historical details and never leaks them into future stages of the current tracing cycle', async () => {
    act(() => root.render(<SegmentLifelineModal segmentId="D1" segmentName="身份锚定" onClose={() => {}} />));
    await flush();
    await flush();

    const switcher = document.querySelector('[data-cycle-switcher]') as HTMLSelectElement;
    act(() => {
      switcher.value = 'cycle-prior';
      switcher.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const priorEval = document.querySelector(
      'button[data-cycle-id="cycle-prior"][data-stage="eval"]',
    ) as HTMLButtonElement;
    act(() => priorEval.click());
    await flush();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('cycleId=cycle-prior'));
    expect(document.body.textContent).toContain('本周期评估结论');
    expect(document.body.textContent).toContain('历史周期结论');

    act(() => {
      switcher.value = 'cycle-current';
      switcher.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const currentEval = document.querySelector(
      'button[data-cycle-id="cycle-current"][data-stage="eval"]',
    ) as HTMLButtonElement;
    act(() => currentEval.click());
    await flush();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('cycleId=cycle-current'));
    expect(document.body.textContent).toContain('本周期尚未进入评估；当前仅展示指标定义。');
    expect(document.body.textContent).not.toContain('历史周期结论');

    const currentGovernance = document.querySelector(
      'button[data-cycle-id="cycle-current"][data-stage="governance"]',
    ) as HTMLButtonElement;
    act(() => currentGovernance.click());
    await flush();
    expect(document.body.textContent).toContain('本周期尚未进入 governance。');
    expect(document.body.textContent).not.toContain('历史周期保持');
  });

  it('selects the active rollback branch for the current cycle instead of the newest-created version', async () => {
    const rollbackLifeline: SegmentLifecycleResponse = {
      ...lifeline,
      activeVersion: 1,
      versionActivations: [
        { timestamp: 0, version: 1 },
        { timestamp: 100, version: 2 },
        { timestamp: 150, version: 1 },
      ],
      chain: [
        { ...lifeline.chain[0], isActive: true },
        {
          ...lifeline.chain[0],
          version: 2,
          parentVersion: 1,
          origin: 'user-create',
          startedAt: 100,
          isActive: false,
        },
      ],
    };
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/segment-lifeline/D1') return { ok: true, json: async () => rollbackLifeline };
      return { ok: true, json: async () => evaluationFor(current) };
    });

    act(() => root.render(<SegmentLifelineModal segmentId="D1" segmentName="身份锚定" onClose={() => {}} />));
    await flush();
    await flush();

    const activeRollbackCycle = document.querySelector(
      '[data-version-node="1"] button[data-cycle-id="cycle-current"][data-stage="tracing"]',
    );
    expect(activeRollbackCycle?.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.querySelector('[data-version-node="2"] button[data-cycle-id="cycle-current"][data-stage="tracing"]'),
    ).toBeNull();
  });

  it('states when evolve changed sibling segments but left the selected segment unchanged', async () => {
    const data = evaluationFor(prior);
    const objective = data.objectives[0];
    objective.latestGovernance = {
      cycleId: prior.cycleId,
      decision: 'evolve',
      reason: '改进同一 Objective 下的兄弟段',
      writtenAt: 220,
      by: 'evaluator',
      approval: null,
      impact: {
        changedUnitIds: ['S13'],
        selectedSegmentChanged: false,
        changes: [{ action: 'modify', unitId: 'S13', sourceVersion: 1, targetVersion: 2 }],
      },
    };

    act(() => root.render(<ObjectiveGovernancePanel data={data} />));

    expect(document.body.textContent).toContain('演进 S13：v1 → v2；本段 D1 未变');
  });

  it('does not present a skipped proposal as an applied version edge', () => {
    const data = evaluationFor(prior);
    data.objectives[0].latestGovernance = {
      cycleId: prior.cycleId,
      decision: 'evolve',
      reason: 'proposal was not accepted',
      writtenAt: 220,
      by: 'evaluator',
      approval: { cardId: 'HGP-skipped', state: 'skipped', rejectCount: 0, at: 230 },
      impact: {
        changedUnitIds: ['S13'],
        selectedSegmentChanged: false,
        changes: [{ action: 'modify', unitId: 'S13', sourceVersion: 1, targetVersion: null }],
      },
    };

    act(() => root.render(<ObjectiveGovernancePanel data={data} />));

    expect(document.body.textContent).toContain('提案未应用，版本未变化');
    expect(document.body.textContent).not.toContain('v1 → v1');
  });

  it('explains that an insufficient-evidence cycle skips governance and rolls its window forward', async () => {
    const data = evaluationFor(prior);
    const objective = data.objectives[0];
    objective.selectedCycle = {
      ...prior,
      evaluation: { overall: 'insufficient_evidence', writtenAt: 210, by: 'evaluator' },
      governance: null,
      governanceImpact: null,
    };
    objective.latestEvaluation = {
      cycleId: prior.cycleId,
      overall: 'insufficient_evidence',
      writtenAt: 210,
      by: 'evaluator',
      windows: prior.windows,
    };
    objective.latestGovernance = null;

    act(() => root.render(<ObjectiveEvaluationPanel data={data} />));
    expect(document.body.textContent).toContain('证据不足，本周期不进入治理；已并入下一周期继续累计。');

    act(() => root.render(<ObjectiveGovernancePanel data={data} />));
    expect(document.body.textContent).toContain('证据不足，本周期不进入治理；已并入下一周期继续累计。');
  });

  it('shows an operator version switch as an explicit stopped cycle', () => {
    const data = evaluationFor(prior);
    const objective = data.objectives[0];
    objective.selectedCycle = {
      ...prior,
      governance: null,
      governanceImpact: null,
      termination: {
        kind: 'manual-version-switch',
        segmentId: 'D1',
        fromVersion: 3,
        toVersion: 2,
        at: 230,
        by: 'default-user',
        reason: '信息不足，切回已验证版本',
      },
    };
    objective.latestGovernance = null;

    act(() => root.render(<ObjectiveGovernancePanel data={data} />));
    expect(document.body.textContent).toContain('已停止');
    expect(document.body.textContent).toContain('D1：v3 → v2');
    expect(document.body.textContent).toContain('信息不足，切回已验证版本');
    expect(document.body.textContent).not.toContain('历史周期保持');
  });

  it('shows a direct branch edit as current version to new version based on the selected history', () => {
    const data = evaluationFor(prior);
    const objective = data.objectives[0];
    objective.selectedCycle = {
      ...prior,
      governance: null,
      governanceImpact: null,
      termination: {
        kind: 'manual-version-switch',
        segmentId: 'D1',
        fromVersion: 2,
        toVersion: 4,
        baseVersion: 1,
        at: 230,
        by: 'default-user',
        reason: '基于 v1 编辑并应用新版本',
      },
    };
    objective.latestGovernance = null;

    act(() => root.render(<ObjectiveGovernancePanel data={data} />));
    expect(document.body.textContent).toContain('当前版本 v2 → v4（基于 v1）');
  });
});
