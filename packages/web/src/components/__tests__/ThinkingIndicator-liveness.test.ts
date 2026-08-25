import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

// Mock useCatData
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex' ? { displayName: '缅因猫 (Codex)', catId: 'codex' } : null),
  }),
}));

const storeState: Record<string, unknown> = {
  targetCats: ['codex'],
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  catStatuses: {} as Record<string, string>,
  catInvocations: {} as Record<string, unknown>,
  currentThreadId: 'thread-1',
};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  ),
}));

describe('F118 ThinkingIndicator liveness states', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    seedExecution('codex');
    storeState.targetCats = ['codex'];
    storeState.activeInvocations = {};
    storeState.catStatuses = {};
    storeState.catInvocations = {};
    storeState.currentThreadId = 'thread-1';
  });

  function seedExecution(catId: string) {
    useActiveExecutionStore.getState().reset();
    const request = useActiveExecutionStore.getState().beginHydration('thread-1');
    useActiveExecutionStore.getState().applySnapshot('thread-1', request, {
      projectPath: '/project/cafe',
      executions: [
        {
          executionId: `inv-${catId}`,
          threadId: 'thread-1',
          threadTitle: 'Current work',
          catId,
          kind: 'live_invocation',
          startedAt: 1000,
          cancelability: {
            state: 'cancelable',
            target: {
              kind: 'live_invocation',
              threadId: 'thread-1',
              catId,
              executionId: `inv-${catId}`,
            },
          },
        },
      ],
    });
  }

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders amber warning for alive_but_silent', async () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 150000,
          cpuTimeMs: 4200,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    const el = container.querySelector('[data-testid="liveness-warning"]');
    expect(el).toBeTruthy();
    expect(el?.textContent).toContain('静默等待');
    expect(el?.textContent).toContain('2m 30s');
    expect(el?.textContent).toContain('进程存活且 CPU 活跃');
    expect(el?.textContent).not.toContain('客户端初始化');
    expect(container.querySelector('button[aria-label="Stop codex live_invocation inv-codex"]')).toBeNull();
  });

  it('renders orange warning without a duplicate stop control for suspected_stall', async () => {
    storeState.catStatuses = { codex: 'suspected_stall' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'suspected_stall',
          state: 'idle-silent',
          silenceDurationMs: 312000,
          processAlive: true,
          firstEventAt: Date.now() - 312000,
          lastEventAt: Date.now() - 312000,
          lastEventType: 'turn.started',
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    const el = container.querySelector('[data-testid="liveness-warning"]');
    expect(el).toBeTruthy();
    expect(el?.textContent).toContain('可能卡住');
    expect(el?.textContent).toContain('5m 12s');
    expect(el?.textContent).toContain('CLI 已开始回合');
    expect(el?.textContent).toContain('客户端初始化或上游连接');

    expect(container.querySelector('button[aria-label="Stop codex live_invocation inv-codex"]')).toBeNull();
  });

  it('explains client initialization when the API explicitly reports no CLI events', async () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'idle-silent',
          silenceDurationMs: 150000,
          processAlive: true,
          firstEventAt: null,
          lastEventAt: null,
          lastEventType: null,
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    expect(container.textContent).toContain('尚未返回任何事件');
    expect(container.textContent).toContain('客户端初始化');
  });

  it('does not render a duplicate cancellation control for a stalled turn', async () => {
    storeState.catStatuses = { codex: 'suspected_stall' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'suspected_stall',
          state: 'idle-silent',
          silenceDurationMs: 312000,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    expect(container.querySelector('button')).toBeNull();
  });

  it('renders from a single active slot even when targetCats is stale or empty', async () => {
    storeState.targetCats = [];
    storeState.activeInvocations = {
      'inv-opus': { catId: 'opus', mode: 'execute' },
    };
    storeState.catStatuses = { opus: 'streaming' };
    seedExecution('opus');

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    expect(container.textContent).toContain('opus');
    expect(container.textContent).toContain('回复中');
  });

  it('uses the single active slot for liveness even when targetCats is stale', async () => {
    storeState.targetCats = ['codex', 'opus'];
    storeState.activeInvocations = {
      'inv-codex': { catId: 'codex', mode: 'execute' },
    };
    storeState.catStatuses = { codex: 'suspected_stall' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'suspected_stall',
          state: 'idle-silent',
          silenceDurationMs: 312000,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    expect(container.textContent).toContain('可能卡住');
    expect(container.querySelector('button')).toBeNull();
  });

  it('normal thinking state renders paw emoji (KD-9: Apple emoji preferred over Lucide SVG)', async () => {
    storeState.catStatuses = { codex: 'thinking' };
    storeState.catInvocations = {};

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    expect(container.textContent).toContain('思考中');
    expect(container.textContent).toContain('🐾');
    expect(container.innerHTML).not.toContain('<svg');
  });
});
