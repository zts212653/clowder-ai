import { createCatId, type ThreadRuntimeBriefV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadRuntimeDetails } from '../ThreadRuntimeDetails';

let runtimeBrief = brief();
const setWorkspaceMode = vi.fn();
const setRightPanelMode = vi.fn();

vi.mock('@/hooks/useThreadRuntimeBrief', () => ({
  useThreadRuntimeBrief: () => ({ brief: runtimeBrief, loading: false, error: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ name: '宪宪' }) }),
  formatCatName: (cat: { name: string }) => cat.name,
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ setWorkspaceMode, setRightPanelMode }),
  },
}));
vi.mock('../ThreadExecutionBar', () => ({ ThreadExecutionBar: () => <div data-testid="execution-controls" /> }));

describe('ThreadRuntimeDetails', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    runtimeBrief = brief();
    setWorkspaceMode.mockClear();
    setRightPanelMode.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders a useful idle state without leaking technical identifiers by default', async () => {
    await act(async () => root.render(<ThreadRuntimeDetails threadId="thread-1" />));

    expect(container.textContent).toContain('当前没有猫在执行');
    expect(container.textContent).toContain('完成 Phase B');
    expect(container.textContent).toContain('推进 Phase C');
    expect(container.textContent).toContain('最近 Session');
    expect(container.textContent).not.toContain('session-secret');
    expect(container.textContent).not.toContain('/workspace/private');

    const diagnostics = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '展开技术信息',
    );
    await act(async () => diagnostics?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('session-secret');
    expect(container.textContent).toContain('/workspace/private');
  });

  it('shows only exact current plans and can open outstanding work', async () => {
    runtimeBrief = {
      ...brief(),
      currentExecutions: [
        {
          catId: 'cat-vjdun65e',
          startedAt: 1,
          confidence: 'confirmed',
          plan: {
            status: 'running',
            updatedAt: 2,
            tasks: [{ id: 'step-1', subject: '验证', status: 'in_progress', activeForm: '验证运行详情' }],
          },
        },
      ],
    };
    await act(async () => root.render(<ThreadRuntimeDetails threadId="thread-1" />));
    expect(container.textContent).toContain('验证运行详情');
    expect(container.textContent).not.toContain('当前没有猫在执行');

    const tasks = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('查看毛线球'),
    );
    await act(async () => tasks?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(setWorkspaceMode).toHaveBeenCalledWith('tasks');
    expect(setRightPanelMode).toHaveBeenCalledWith('workspace');
  });
});

function brief(): ThreadRuntimeBriefV1 {
  return {
    v: 1 as const,
    thread: { id: 'thread-1', title: 'F308' },
    availability: 'ok' as const,
    currentExecutions: [],
    recentSessions: [
      {
        sessionId: 'session-secret',
        cliSessionId: 'cli-secret',
        catId: 'cat-vjdun65e',
        status: 'sealed' as const,
        messageCount: 8,
        updatedAt: Date.now(),
        workingDirectory: '/workspace/private',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        contextHealth: { fillRatio: 0.5, source: 'exact' as const, measuredAt: Date.now() },
      },
    ],
    latestProgress: {
      id: 'receipt-secret',
      kind: 'milestone' as const,
      headline: '完成 Phase B',
      nextStep: '推进 Phase C',
      actor: { kind: 'cat' as const, catId: createCatId('cat-vjdun65e') },
      occurredAt: Date.now(),
    },
    nextStep: '推进 Phase C',
    openWorkTaskCount: 2,
    anchors: { worktrees: ['/workspace/private'], prs: [], issues: [], features: ['F308'] },
    generatedAt: Date.now(),
  };
}
