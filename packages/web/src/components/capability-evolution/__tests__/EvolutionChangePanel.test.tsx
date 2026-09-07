import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvolutionChangePanel } from '../EvolutionChangePanel';
import {
  type EvolutionChangeLineage,
  type EvolutionProgramProjection,
  isProjection,
} from '../evolution-program-projection';

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const currentChange = (status: EvolutionChangeLineage['status']): EvolutionChangeLineage => ({
  caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:case-1' },
  proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-1' },
  ownerAuthorizationRef: {
    ownerFeatureId: 'F202',
    ownerStateRef: 'execution-permission:investor-roadshow-expression-v1',
  },
  targetVersionRef: {
    ownerFeatureId: 'F202',
    ownerStateRef: 'skill:investor-roadshow-expression',
    version: 'v1',
    assetKind: 'skill',
    assetId: 'investor-roadshow-expression',
  },
  status,
});

function projection(stage: string, sequence: number, current?: EvolutionChangeLineage): EvolutionProgramProjection {
  return {
    program: {
      programId: 'evolution-program:abc',
      workspaceId: 'user:operator',
      objectRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:investor-roadshow-expression' },
      claimRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-claim:abc' },
      lifecycle: 'active',
      stage,
      sequence,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    drafts: {
      goal: { ownerFeatureId: 'F311', ownerStateRef: 'goal:abc' },
      claim: { ownerFeatureId: 'F311', ownerStateRef: 'claim:abc' },
      measurement: { ownerFeatureId: 'F267', ownerStateRef: 'measurement:abc' },
      economic: { ownerFeatureId: 'F311', ownerStateRef: 'economic:abc' },
      roles: {},
    },
    blockers: [],
    nextAction: { code: 'continue_stage', label: '继续当前阶段' },
    observation: { status: 'insufficient', connectedEyes: [], gaps: [] },
    attribution: null,
    lineage: {
      cycles: [{ cycle: 1, changes: current ? [current] : [] }],
      ...(current ? { current } : {}),
    },
  };
}

function Harness({ initial }: { initial: EvolutionProgramProjection }) {
  const [value, setValue] = useState(initial);
  return <EvolutionChangePanel projection={value} onProjection={setValue} />;
}

describe('F311 Change & Learn permanent surface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows exact owner lineage and syncs it with a ref-free operation', async () => {
    const awaiting = projection('awaiting_approval', 8, currentChange('pending'));
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'waiting', projection: awaiting }), { status: 200 }),
    );
    await act(async () => root.render(<Harness initial={awaiting} />));

    expect(container.textContent).toContain('eval-repair-case:case-1');
    expect(container.textContent).toContain('eval-repair-proposal:proposal-1');
    expect(container.textContent).toContain('execution-permission:investor-roadshow-expression-v1');
    expect(container.textContent).toContain('v1');
    const sync = [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新批准状态');
    if (!sync) throw new Error('change sync action missing');
    await act(async () => sync.click());

    const [path, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/capability-evolution/programs/evolution-program%3Aabc/changes');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedSequence: 8,
      clientMessageId: 'workbench:change:sync:evolution-program:abc:sequence:8',
      action: { kind: 'sync' },
    });
    expect(container.textContent).toContain('Owner 仍在处理');
  });

  it('keeps proposal creation on the authenticated cat ingress instead of the browser', async () => {
    const awaiting = projection('awaiting_approval', 7);
    await act(async () => root.render(<Harness initial={awaiting} />));
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('提交'))).toBe(
      false,
    );
    expect(container.textContent).toContain('认证猫');
    expect(container.textContent).toContain('Workbench 不构造 Approval');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('adopts a conflict projection without hiding the fresh sequence as an HTTP error', async () => {
    const awaiting = projection('awaiting_approval', 8, currentChange('pending'));
    const refreshed = projection('awaiting_approval', 9, currentChange('pending'));
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'conflict', actualSequence: 9, projection: refreshed }), {
        status: 409,
      }),
    );
    await act(async () => root.render(<Harness initial={awaiting} />));
    const sync = [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新批准状态');
    if (!sync) throw new Error('change sync action missing');
    await act(async () => sync.click());

    expect(container.textContent).toContain('Program 已同步到最新 sequence');
    expect(container.textContent).not.toContain('Change owner request failed (409)');
  });

  it('shows a reason-only canonical owner blocker without requiring an invented ref', async () => {
    const awaiting = projection('awaiting_approval', 8, currentChange('pending'));
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'blocked', blockerReason: 'proposal_not_found', projection: awaiting }), {
        status: 200,
      }),
    );
    await act(async () => root.render(<Harness initial={awaiting} />));
    const sync = [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新批准状态');
    if (!sync) throw new Error('change sync action missing');
    await act(async () => sync.click());

    expect(container.textContent).toContain('Owner 拒绝执行：proposal_not_found');
  });

  it('offers every metabolism decision only after a fresh outcome', async () => {
    const outcome = {
      ...currentChange('outcome'),
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:proposal-1' },
      interventionKind: 'changed',
      interventionReceiptRef: { ownerFeatureId: 'F202', ownerStateRef: 'mutation-receipt:m1' },
      assetVersionRef: {
        ownerFeatureId: 'F202',
        ownerStateRef: 'skill:investor-roadshow-expression',
        version: 'v2',
        assetKind: 'skill',
        assetId: 'investor-roadshow-expression',
      },
      outcomeReceiptRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-outcome:o1' },
      loadedRuntimeRef: { ownerFeatureId: 'F302', ownerStateRef: 'loaded-runtime:alpha-v2' },
      freshnessProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:post-load-o1' },
    } satisfies EvolutionChangeLineage;
    const deciding = projection('deciding', 11, outcome);
    const terminal = structuredClone(deciding);
    terminal.program.lifecycle = 'terminal';
    terminal.program.sequence = 12;
    terminal.lineage.cycles[0].decision = 'no_change';
    terminal.lineage.cycles[0].decisionRef = {
      ownerFeatureId: 'F266',
      ownerStateRef: 'eval-repair-decision:no-change-1',
    };
    terminal.lineage.cycles[0].executionReceiptRef = {
      ownerFeatureId: 'F202',
      ownerStateRef: 'no-change-receipt:n1',
    };
    terminal.lineage.cycles[0].decisionAssetVersionRef = outcome.assetVersionRef;
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'appended', projection: terminal }), { status: 200 }),
    );
    await act(async () => root.render(<Harness initial={deciding} />));

    expect(container.textContent).toContain('Asset version');
    for (const label of ['Keep', 'Tune', 'Rollback', 'Sunset', 'No change']) {
      expect([...container.querySelectorAll('button')].some((button) => button.textContent === label)).toBe(true);
    }
    const noChange = [...container.querySelectorAll('button')].find((button) => button.textContent === 'No change');
    if (!noChange) throw new Error('no-change action missing');
    await act(async () => noChange.click());

    expect(JSON.parse(String((apiFetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      expectedSequence: 11,
      clientMessageId: 'workbench:change:decide-no_change:evolution-program:abc:sequence:11',
      action: { kind: 'decide', decision: 'no_change' },
    });
    expect(container.textContent).toContain('no_change');
  });

  it('explains fresh-proposal custody after terminal Approval states without exposing browser actions', async () => {
    for (const status of ['rejected', 'withdrawn', 'superseded', 'target_drift'] as const) {
      await act(async () =>
        root.render(<Harness initial={projection('awaiting_approval', 9, currentChange(status))} />),
      );
      expect(container.textContent).toContain('fresh proposal');
      expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('提交'))).toBe(
        false,
      );
      expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Keep')).toBe(false);
    }
  });

  it('does not expose metabolism actions for a deciding projection without complete outcome lineage', async () => {
    await act(async () => root.render(<Harness initial={projection('deciding', 11, currentChange('pending'))} />));
    for (const label of ['Keep', 'Tune', 'Rollback', 'Sunset', 'No change']) {
      expect([...container.querySelectorAll('button')].some((button) => button.textContent === label)).toBe(false);
    }
  });

  it('accepts a fresh owner no-change outcome without inventing a loaded runtime', async () => {
    const outcome = {
      ...currentChange('outcome'),
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:proposal-1' },
      interventionKind: 'no_change',
      interventionReceiptRef: { ownerFeatureId: 'F202', ownerStateRef: 'no-change-intervention-receipt:n1' },
      assetVersionRef: currentChange('pending').targetVersionRef,
      outcomeReceiptRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-outcome:no-change-1' },
      freshnessProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:post-no-change-1' },
    } satisfies EvolutionChangeLineage;

    await act(async () => root.render(<Harness initial={projection('deciding', 11, outcome)} />));
    expect(container.textContent).toContain('no-change-intervention-receipt:n1');
    expect(container.textContent).not.toContain('loaded-runtime');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'No change')).toBe(true);
  });

  it('fails closed when a runtime has not loaded the Phase 4 lineage contract', () => {
    const prePhaseFour: Partial<EvolutionProgramProjection> = projection('observing', 4);
    delete prePhaseFour.lineage;
    expect(isProjection(prePhaseFour)).toBe(false);
  });

  it('fails closed when an outcome status omits owner mutation, runtime or freshness refs', () => {
    expect(isProjection(projection('deciding', 11, currentChange('outcome')))).toBe(false);
  });

  it('fails closed when a change cycle omits owner-backed authorization', () => {
    const change = currentChange('pending') as Partial<EvolutionChangeLineage>;
    delete change.ownerAuthorizationRef;
    expect(isProjection(projection('awaiting_approval', 8, change as EvolutionChangeLineage))).toBe(false);
  });

  it('fails closed when no-change omits its owner receipt or exact unchanged asset version', () => {
    const outcome: EvolutionChangeLineage = {
      ...currentChange('outcome'),
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:proposal-1' },
      interventionKind: 'changed',
      interventionReceiptRef: { ownerFeatureId: 'F202', ownerStateRef: 'mutation-receipt:m1' },
      assetVersionRef: {
        ownerFeatureId: 'F202',
        ownerStateRef: 'skill:investor-roadshow-expression',
        version: 'v2',
        assetKind: 'skill',
        assetId: 'investor-roadshow-expression',
      },
      outcomeReceiptRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-outcome:o1' },
      loadedRuntimeRef: { ownerFeatureId: 'F302', ownerStateRef: 'loaded-runtime:alpha-v2' },
      freshnessProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:post-load-o1' },
    };
    const terminal = projection('deciding', 11, outcome);
    terminal.program.lifecycle = 'terminal';
    terminal.lineage.cycles[0].decision = 'no_change';
    terminal.lineage.cycles[0].decisionRef = {
      ownerFeatureId: 'F266',
      ownerStateRef: 'eval-repair-decision:no-change-without-proof',
    };
    expect(isProjection(terminal)).toBe(false);

    terminal.lineage.cycles[0].executionReceiptRef = {
      ownerFeatureId: 'F202',
      ownerStateRef: 'no-change-receipt:n1',
    };
    expect(isProjection(terminal)).toBe(false);
  });
});
