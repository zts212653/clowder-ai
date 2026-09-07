import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityEvolutionWorkspace } from '../CapabilityEvolutionWorkspace';

const { apiFetchMock, setPendingChatInsert, onOpenProgram, chatStoreState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  setPendingChatInsert: vi.fn(),
  onOpenProgram: vi.fn(),
  chatStoreState: {
    currentThreadId: 'thread-current-but-unrelated',
    threads: [
      { id: 'thread-f311', title: '路演表达进化' },
      { id: 'thread-other', title: '视频工作台' },
    ],
  },
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...chatStoreState,
      setPendingChatInsert,
    }),
}));

const projection = {
  program: {
    schemaVersion: 1,
    programId: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68',
    workspaceId: 'user:default-user',
    objectRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:f311-investor-roadshow-expression' },
    claimRef: {
      ownerFeatureId: 'F311',
      ownerStateRef: 'evolution-claim:evolution-program:bcc336788a7df9d6075b1efb4c0a7e68',
    },
    certificates: {},
    measurementRoleRefs: {},
    currentAssetVersionRefs: [],
    lifecycle: 'active',
    stage: 'constituting',
    cycle: 1,
    sequence: 1,
    createdAt: '2026-09-01T07:30:53.931Z',
    updatedAt: '2026-09-01T07:30:53.931Z',
  },
  cycles: [
    {
      programId: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68',
      cycle: 1,
      stage: 'constituting',
      lineageRefIds: [
        'capability:f311-investor-roadshow-expression',
        'evolution-claim:evolution-program:bcc336788a7df9d6075b1efb4c0a7e68',
      ],
      openedAt: '2026-09-01T07:30:53.931Z',
    },
  ],
  drafts: {
    goal: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-goal-draft:program' },
    measurement: { ownerFeatureId: 'F267', ownerStateRef: 'evolution-measurement-draft:program' },
    economic: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-economic-draft:program' },
    roles: {},
  },
  blockers: [
    {
      code: 'measurement_certificate_missing',
      message: 'Measurement certificate 仍待 F267/source owner 签发。',
      ownerFeatureId: 'F267',
    },
  ],
  nextAction: { code: 'complete_constitution', label: '继续自动建制' },
};

describe('F311 Capability Evolution Workspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiFetchMock.mockReset();
    setPendingChatInsert.mockReset();
    onOpenProgram.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderWorkspace(targetThreadId: string | null = 'thread-f311') {
    await act(async () =>
      root.render(<CapabilityEvolutionWorkspace targetThreadId={targetThreadId} onOpenProgram={onOpenProgram} />),
    );
  }

  it('shows a product status first and keeps setup mechanics below the selected capability', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [projection] }), { status: 200 }));
    await renderWorkspace();

    expect(container.textContent).toContain('能力进化');
    expect(container.textContent).toContain('投资人路演效果');
    expect(container.textContent).toContain('配置中');
    expect(container.textContent).toContain('1 项评估条件待完成');
    expect(container.textContent).not.toContain('F311');
    expect(container.textContent).not.toContain('Measurement certificate');
    expect(container.textContent).not.toContain('capability:f311-investor-roadshow-expression');
    expect(container.textContent).not.toContain('能力进化目标');
    expect(container.textContent).not.toContain('下一步：');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="capability-evolution-program-evolution-program:bcc336788a7df9d6075b1efb4c0a7e68"]',
        )
        ?.click();
    });

    const setup = container.querySelector('[data-testid="capability-evolution-setup"]');
    expect(setup?.textContent).toContain('评估配置');
    expect(setup?.textContent).toContain('1 项待完成');
    expect(setup?.textContent).toContain('接好评估方式');
    expect(setup?.textContent).toContain('评估体系');
    expect(setup?.textContent).not.toContain('F267');
    expect(setup?.textContent).not.toContain('Measurement certificate');
    expect(container.textContent).not.toContain('你现在是否需要行动');

    const technical = container.querySelector<HTMLDetailsElement>(
      '[data-testid="capability-evolution-technical-details"]',
    );
    expect(technical?.open).toBe(false);
    expect(technical?.textContent).toContain('F311');
    expect(technical?.textContent).toContain('Measurement certificate');
    expect(technical?.textContent).toContain('Program sequence 1');
    expect(technical?.textContent).toContain('evolution-claim:evolution-program:bcc336788a7df9d6075b1efb4c0a7e68');
  });

  it.each([
    {
      lifecycle: 'paused',
      nextAction: { code: 'resume_program', label: '恢复 Program' },
      status: '已暂停',
      conclusion: '这项能力已暂停，现有记录仍然保留。',
      blockers: [
        {
          code: 'program_paused',
          message: 'Program 已暂停；生命周期与历史仍永久保留。',
          ownerFeatureId: 'F311',
        },
      ],
    },
    {
      lifecycle: 'needs_expert',
      nextAction: { code: 'bind_expert', label: '绑定缺失角色' },
      status: '等待专家',
      conclusion: '需要专业判断，当前进度已挂起。',
      blockers: [
        {
          code: 'expert_required',
          message: '当前 claim 缺少合格的 domain_owner，只挂起这条 Program。',
          ownerFeatureId: 'F267',
          ownerStateRef: 'expert-assignment:domain-owner',
        },
      ],
    },
    {
      lifecycle: 'terminal',
      nextAction: { code: 'inspect_history', label: '查看完整生命周期' },
      status: '已完成',
      conclusion: '本轮已经结束，结论与证据已保留。',
      blockers: [],
    },
  ])('keeps lifecycle $lifecycle in product language without inventing an action', async (scenario) => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          programs: [
            {
              ...projection,
              program: {
                ...projection.program,
                lifecycle: scenario.lifecycle,
                ...(scenario.lifecycle === 'terminal' ? { terminalDisposition: 'no_change' } : {}),
              },
              cycles:
                scenario.lifecycle === 'terminal'
                  ? projection.cycles.map((cycle) => ({
                      ...cycle,
                      closedAt: '2026-09-01T08:30:53.931Z',
                      decision: 'no_change',
                    }))
                  : projection.cycles,
              blockers: scenario.blockers,
              nextAction: scenario.nextAction,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await renderWorkspace();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="capability-evolution-program-evolution-program:bcc336788a7df9d6075b1efb4c0a7e68"]',
        )
        ?.click();
    });

    expect(container.textContent).toContain(scenario.status);
    expect(container.textContent).toContain(scenario.conclusion);
    if (scenario.lifecycle === 'terminal') {
      expect(container.querySelector('[data-testid="capability-evolution-conclusion"]')).not.toBeNull();
    } else {
      expect(container.querySelector('[data-testid="capability-evolution-lifecycle-status"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="capability-evolution-setup"]')).toBeNull();
      expect(container.textContent).not.toContain('补齐一项评估条件');
      expect(container.textContent).not.toContain('完成后才会开始观测');
    }
    expect(container.textContent).not.toContain(scenario.nextAction.label);
  });

  it('renders the three real capabilities as independent rows with their own state', async () => {
    const ownerRef = (ownerStateRef: string) => ({ ownerFeatureId: 'F311', ownerStateRef });
    const program = (id: string, ownerStateRef: string, stage: string, blockers: typeof projection.blockers) => {
      const readyRefs =
        stage === 'constituting'
          ? {}
          : {
              certificates: {
                goal: ownerRef(`goal:${id}`),
                measurement: ownerRef(`measurement:${id}`),
                economic: ownerRef(`economic:${id}`),
              },
              valueOwnerRef: ownerRef(`value-owner:${id}`),
              measurementRoleRefs: {
                observer: ownerRef(`observer:${id}`),
                domainOwner: ownerRef(`domain-owner:${id}`),
                consumer: ownerRef(`consumer:${id}`),
                calibrator: ownerRef(`calibrator:${id}`),
              },
            };
      return {
        ...projection,
        program: {
          ...projection.program,
          programId: id,
          objectRef: { ownerFeatureId: 'F311', ownerStateRef },
          stage,
          ...readyRefs,
        },
        cycles: projection.cycles.map((cycle) => ({ ...cycle, programId: id, stage })),
        blockers,
      };
    };
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          programs: [
            program(
              'evolution-program:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              'capability:development-process-harness-effectiveness',
              'instrumenting',
              [projection.blockers[0], { ...projection.blockers[0], code: 'promotion_holdout_missing' }],
            ),
            program(
              'evolution-program:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              'capability:microduck-walking-stability',
              'constituting',
              [projection.blockers[0]],
            ),
            program(
              'evolution-program:cccccccccccccccccccccccccccccccc',
              'capability:f311-investor-roadshow-expression',
              'observing',
              [],
            ),
          ],
        }),
        { status: 200 },
      ),
    );

    await renderWorkspace();

    const rows = [...container.querySelectorAll('[data-testid^="capability-evolution-program-"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('研发协作改进');
    expect(rows[0]?.textContent).toContain('2 项评估条件待完成');
    expect(rows[1]?.textContent).toContain('Microduck 行走稳定性');
    expect(rows[1]?.textContent).toContain('1 项评估条件待完成');
    expect(rows[2]?.textContent).toContain('投资人路演效果');
    expect(rows[2]?.textContent).toContain('正在收集本轮证据');
    expect(container.textContent).not.toContain('三个阶段');
  });

  it('F305 contract: shows the bound destination, then confirms the draft handoff without mechanism copy', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [] }), { status: 200 }));
    await renderWorkspace();

    const input = container.querySelector<HTMLInputElement>('[data-testid="capability-evolution-start-input"]');
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '视频讲解能力');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="capability-evolution-chat-destination"]')?.textContent).toContain(
      '路演表达进化',
    );
    expect(container.querySelector('[data-testid="capability-evolution-draft-preview"]')).toBeNull();
    expect(container.textContent).not.toContain('将加入输入框');
    expect(container.textContent).not.toContain('只加入输入框，不会自动发送');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="capability-evolution-start"]')?.textContent).toBe(
      '带到这个对话',
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="capability-evolution-start"]')?.click();
    });

    const inserted = setPendingChatInsert.mock.calls[0]?.[0];
    expect(inserted).toEqual({
      threadId: 'thread-f311',
      text: '我们来进化 视频讲解能力',
    });
    expect(inserted).not.toHaveProperty('authoritative');
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('已带到「路演表达进化」');
    expect(container.textContent).toContain('原有草稿已保留');
    expect(container.textContent).toContain('由你确认后发送');
  });

  it('follows the surface-bound target when the destination changes instead of the global focused thread', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [] }), { status: 200 }));
    await renderWorkspace('thread-f311');
    await renderWorkspace('thread-other');

    const input = container.querySelector<HTMLInputElement>('[data-testid="capability-evolution-start-input"]');
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '视频讲解能力');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="capability-evolution-chat-destination"]')?.textContent).toContain(
      '视频工作台',
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="capability-evolution-start"]')?.click();
    });

    expect(setPendingChatInsert).toHaveBeenCalledWith({
      threadId: 'thread-other',
      text: '我们来进化 视频讲解能力',
    });
    expect(setPendingChatInsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: chatStoreState.currentThreadId }),
    );
  });

  it('honestly disables admission when the workspace has no writable conversation target', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [] }), { status: 200 }));
    await renderWorkspace(null);

    const input = container.querySelector<HTMLInputElement>('[data-testid="capability-evolution-start-input"]');
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '视频讲解能力');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="capability-evolution-chat-destination"]')?.textContent).toContain(
      '没有可写入的目标对话',
    );
    expect(container.textContent).toContain('请先回到一个对话');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="capability-evolution-start"]')?.disabled).toBe(
      true,
    );
    expect(setPendingChatInsert).not.toHaveBeenCalled();
  });

  it('shows an honest owner-unavailable state without a mock list', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    await renderWorkspace();

    expect(container.textContent).toContain('暂时无法读取进化记录');
    expect(container.textContent).not.toContain('Program owner');
    expect(container.querySelectorAll('[data-testid^="capability-evolution-program-"]')).toHaveLength(0);
  });
  it('keeps lifecycle controls reachable from Program detail', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [projection] }), { status: 200 }));
    await renderWorkspace();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="capability-evolution-program-evolution-program:bcc336788a7df9d6075b1efb4c0a7e68"]',
        )
        ?.click();
    });
    const manage = [...container.querySelectorAll('button')].find((button) => button.textContent === '管理');
    if (!manage) throw new Error('lifecycle entry missing from Program detail');
    act(() => manage.click());

    expect(onOpenProgram).toHaveBeenCalledWith('evolution-program:bcc336788a7df9d6075b1efb4c0a7e68');
  });

  it('does not describe rejected canonical projections as an empty workspace', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ programs: [{ program: { schemaVersion: 2 } }] }), { status: 200 }),
    );
    await renderWorkspace();

    expect(container.textContent).toContain('1 项进化记录暂时无法读取');
    expect(container.textContent).not.toContain('还没有进化记录');
    expect(container.textContent).not.toContain('在上方写下想改进什么');
  });
});
