import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvolutionProgramList, EvolutionProgramSurface } from '../EvolutionProgramSurface';

const apiFetchMock = vi.fn();
const navigationMocks = vi.hoisted(() => ({ openInvocationTrajectory: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/workspace/trajectory/trajectory-navigation', () => ({
  openInvocationTrajectory: navigationMocks.openInvocationTrajectory,
}));

const projection = {
  program: {
    programId: 'evolution-program:abc',
    workspaceId: 'user:operator',
    objectRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:video-forge', version: 'v1' },
    claimRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-claim:evolution-program:abc' },
    lifecycle: 'active',
    stage: 'constituting',
    sequence: 1,
    createdAt: '2026-08-31T22:00:00.000Z',
    updatedAt: '2026-08-31T22:00:00.000Z',
  },
  drafts: {
    goal: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-goal-draft:evolution-program:abc' },
    measurement: { ownerFeatureId: 'F267', ownerStateRef: 'evolution-measurement-draft:evolution-program:abc' },
    economic: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-economic-draft:evolution-program:abc' },
    roles: {
      observer: { ownerFeatureId: 'F267', ownerStateRef: 'evolution-role-draft:evolution-program:abc:observer' },
      calibrator: { ownerFeatureId: 'F267', ownerStateRef: 'evolution-role-draft:evolution-program:abc:calibrator' },
    },
  },
  blockers: [
    {
      code: 'measurement_certificate_missing',
      message: 'Measurement certificate 仍待 F267/source owner 签发。',
      ownerFeatureId: 'F267',
    },
  ],
  nextAction: { code: 'complete_constitution', label: '继续自动建制' },
  observation: {
    status: 'connected',
    trajectory: {
      ref: { ownerFeatureId: 'F299', ownerStateRef: 'inv:invocation-1' },
      invocationId: 'invocation-1',
      threadId: 'thread-owner',
    },
    connectedEyes: [
      {
        sourceKind: 'paw-feel-disposition',
        ownerSurfaceRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel:signal-1' },
        joinKey: 'message:message-1',
        namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
        instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:paw-feel-v1' },
        ownerHref: '/api/paw-feel/source/message-1',
      },
      {
        sourceKind: 'human-disposition',
        ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:decision-1' },
        joinKey: 'subject:proposal-1',
        namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
        instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:human-disposition-v1' },
        ownerHref: '/api/human-disposition-feedback/episodes?subjectRef=proposal-1',
      },
    ],
    evidenceProofRefs: {
      decisionProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
      evidenceRoleRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-role:observer-1' },
      consumptionProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-consumption:receipt-1' },
      optimizerExposureProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'optimizer-exposure:proof-1' },
      promotionHoldoutRef: { ownerFeatureId: 'F267', ownerStateRef: 'promotion-holdout:holdout-1' },
    },
    trigger: {
      registrationRef: { ownerFeatureId: 'F192', ownerStateRef: 'eval-domain:eval:capability-evolution' },
      channels: ['event', 'quota', 'time'],
    },
    nextEvaluationAt: '2026-09-06T03:00:00.000Z',
    gaps: [],
    hiddenOwnerPayload: 'DO NOT RENDER',
  },
};

describe('F311 Evolution Program Workbench surface', () => {
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

  async function renderView(view: React.ReactNode) {
    await act(async () => root.render(view));
  }

  it('reads the canonical projection and shows lifecycle, refs, blocker, and next action', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify(projection), { status: 200 }));
    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);

    expect(container.textContent).toContain('active');
    expect(container.textContent).toContain('constituting');
    expect(container.textContent).toContain('skill:video-forge');
    expect(container.textContent).toContain('measurement_certificate_missing');
    expect(container.textContent).toContain('继续自动建制');
  });

  it('shows real connected eyes, gaps, F192 timing, and owner drilldowns without copying payloads', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify(projection), { status: 200 }));
    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);

    expect(container.textContent).toContain('已接眼睛');
    expect(container.textContent).toContain('paw-feel-disposition');
    expect(container.textContent).toContain('human-disposition');
    expect(container.textContent).toContain('2026-09-06');
    expect(container.textContent).toContain('event · quota · time');
    expect(container.textContent).not.toContain('DO NOT RENDER');
    const trajectory = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('inv:invocation-1'),
    );
    if (!trajectory) throw new Error('trajectory drilldown missing');
    act(() => trajectory.click());
    expect(navigationMocks.openInvocationTrajectory).toHaveBeenCalledWith({
      invocationId: 'invocation-1',
      threadId: 'thread-owner',
    });
    expect(container.querySelector('a[href="/api/paw-feel/source/message-1"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="/api/human-disposition-feedback/episodes?subjectRef=proposal-1"]'),
    ).not.toBeNull();
  });

  it('renders the attribution explanation inside the Program surface, not only as a standalone panel', async () => {
    const attribution = {
      schemaVersion: 1,
      verdict: 'unresolved',
      headline: '证据还不能确诊是哪一层出的问题。',
      evidence: [
        { label: '本轮度量结果', ownerFeatureId: 'F267', ownerStateRef: 'measurement-result:evolve-video-skill:w7' },
      ],
      competingAttributions: [{ layer: 'execution', label: '执行层：被进化的对象自己', discriminating: true }],
      notAssessedLayers: [{ layer: 'rubric', label: '尺子层（这一轮没有证据，只是没看，不等于已排除）' }],
      confidence: { basis: 'interval', label: '有区间估计：这次结论带着可复核的置信区间。' },
      comparability: { status: 'comparable', label: '尺子没换版，前后可以直接比。' },
      whyNotChange: ['归因还没确诊，现在改就是碰运气。'],
      gate: {
        status: 'blocked',
        blockers: [
          {
            code: 'intervention_card_missing',
            label: '还没有 owner 持有的 intervention card。',
            ownerFeatureId: 'F267',
          },
        ],
      },
    };
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ ...projection, attribution }), { status: 200 }));
    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);

    expect(container.querySelector('[data-testid="evolution-attribution-panel"]')).not.toBeNull();
    expect(container.textContent).toContain('证据还不能确诊是哪一层出的问题。');
    expect(container.textContent).toContain('现在改就是碰运气');
    expect(container.textContent).toContain('只是没看，不等于已排除');
    expect(container.querySelector('[data-blocker-code="intervention_card_missing"]')).not.toBeNull();
  });

  it('says the round has no evaluation yet instead of hiding the panel', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ ...projection, attribution: null }), { status: 200 }));
    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);

    expect(container.textContent).toContain('这一轮还没有评估结果');
  });

  it('fails closed when an older API projection lacks the observation contract', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ ...projection, observation: {} }), { status: 200 }));
    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);

    expect(container.textContent).toContain('Program projection is invalid');
    expect(container.textContent).not.toContain('已接眼睛');
  });

  it('sends lifecycle choices only through the Program command API', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projection), { status: 200 })).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          outcome: 'appended',
          projection: { ...projection, program: { ...projection.program, lifecycle: 'paused' } },
        }),
        { status: 200 },
      ),
    );
    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);
    const pause = [...container.querySelectorAll('button')].find((button) => button.textContent === '暂停 Program');
    if (!pause) throw new Error('pause action missing');
    await act(async () => pause.click());

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const [path, init] = apiFetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe('/api/capability-evolution/programs/evolution-program%3Aabc/commands');
    const body = JSON.parse(String(init.body));
    expect(body.action.type).toBe('pause');
    expect(body.clientMessageId).toBe('workbench:pause:evolution-program:abc:sequence:1');
    expect(body).not.toHaveProperty('actorRef');
    expect(body).not.toHaveProperty('workspaceId');
    expect(body).not.toHaveProperty('stage');
  });

  it('adopts the latest projection after a stale-sequence conflict', async () => {
    const latest = {
      ...projection,
      program: { ...projection.program, lifecycle: 'paused', sequence: 2 },
    };
    apiFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(projection), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ outcome: 'conflict', actualSequence: 2, projection: latest }), { status: 409 }),
      );

    await renderView(<EvolutionProgramSurface programId="evolution-program:abc" />);
    const pause = [...container.querySelectorAll('button')].find((button) => button.textContent === '暂停 Program');
    if (!pause) throw new Error('pause action missing');
    await act(async () => pause.click());

    expect(container.textContent).toContain('paused');
    expect(container.textContent).toContain('sequence 2');
    expect(container.textContent).toContain('已被其他操作者更新，已同步到最新状态');
    expect(container.querySelector('[data-notice-code="program_state_synchronized"]')).not.toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '恢复 Program')).toBe(
      true,
    );
    expect(container.textContent).not.toContain('Program command failed (409)');
  });

  it('makes every canonical Program immediately discoverable on Workbench Home', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [projection] }), { status: 200 }));
    const onOpenProgram = vi.fn();
    await renderView(<EvolutionProgramList onOpenProgram={onOpenProgram} />);

    const program = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('video-forge'),
    );
    if (!program) throw new Error('Program list item missing');
    act(() => program.click());
    expect(onOpenProgram).toHaveBeenCalledWith('evolution-program:abc');
  });

  it('distinguishes the initial canonical read from a genuinely empty workspace', async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    await renderView(<EvolutionProgramList onOpenProgram={() => undefined} />);

    expect(container.textContent).toContain('正在读取 canonical Programs');
    expect(container.textContent).not.toContain('说“我们来进化 X”');
  });

  it('pauses background list polling while hidden and refreshes when visibility returns', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [projection] }), { status: 200 }));
    try {
      await renderView(<EvolutionProgramList onOpenProgram={() => undefined} />);
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(apiFetchMock).toHaveBeenCalledTimes(1);

      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('shows a bounded owner-unavailable state without inventing a local Program', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    await renderView(<EvolutionProgramList onOpenProgram={() => undefined} />);

    expect(container.textContent).toContain('Program owner 暂时不可用');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
