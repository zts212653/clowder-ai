import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityEvolutionWorkspace } from '../CapabilityEvolutionWorkspace';

const apiFetchMock = vi.fn();
const setPendingChatInsert = vi.fn();
const onOpenProgram = vi.fn();

vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentThreadId: 'thread-f311',
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

  async function renderWorkspace() {
    await act(async () => root.render(<CapabilityEvolutionWorkspace onOpenProgram={onOpenProgram} />));
  }

  it('leads with human progress and next action, keeping blockers in Program details', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [projection] }), { status: 200 }));
    await renderWorkspace();

    expect(container.textContent).toContain('能力进化');
    expect(container.textContent).toContain('F311');
    expect(container.textContent).toContain('投资人路演表达能力');
    expect(container.textContent).toContain('建制中');
    expect(container.textContent).toContain('继续自动建制');
    expect(container.textContent).not.toContain('capability:f311-investor-roadshow-expression');
    expect(container.textContent).not.toContain('Measurement certificate');
    expect(container.textContent).not.toContain('1 个阻塞');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="capability-evolution-program-evolution-program:bcc336788a7df9d6075b1efb4c0a7e68"]',
        )
        ?.click();
    });

    expect(container.textContent).toContain('待处理阻塞');
    expect(container.textContent).toContain('Measurement certificate');
    expect(container.textContent).toContain('历史与能力谱系');
    expect(container.textContent).toContain('2 条 lineage 引用');
    expect(container.textContent).toContain('evolution-claim:evolution-program:bcc336788a7df9d6075b1efb4c0a7e68');
  });

  it('starts through the canonical chat phrase instead of guessing an owner ref in the browser', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ programs: [] }), { status: 200 }));
    await renderWorkspace();

    const input = container.querySelector<HTMLInputElement>('[data-testid="capability-evolution-start-input"]');
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '视频讲解能力');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="capability-evolution-start"]')?.click();
    });

    expect(setPendingChatInsert).toHaveBeenCalledWith({
      threadId: 'thread-f311',
      text: '我们来进化 视频讲解能力',
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('已放进当前聊天输入框');
  });

  it('shows an honest owner-unavailable state without a mock list', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    await renderWorkspace();

    expect(container.textContent).toContain('Program owner 暂时不可用');
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
    const manage = [...container.querySelectorAll('button')].find((button) => button.textContent === '管理生命周期');
    if (!manage) throw new Error('lifecycle entry missing from Program detail');
    act(() => manage.click());

    expect(onOpenProgram).toHaveBeenCalledWith('evolution-program:bcc336788a7df9d6075b1efb4c0a7e68');
  });

  it('does not describe rejected canonical projections as an empty workspace', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ programs: [{ program: { schemaVersion: 2 } }] }), { status: 200 }),
    );
    await renderWorkspace();

    expect(container.textContent).toContain('1 个 Program 暂时无法读取');
    expect(container.textContent).not.toContain('还没有 Program');
    expect(container.textContent).not.toContain('在上方写下想改进什么');
  });
});
