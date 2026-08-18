/**
 * F122B AC-B8: ThreadExecutionBar shows per-cat active status with elapsed time.
 * B8/B9 polish: cat names from cat-config (formatCatName), colors from cat.color.primary.
 */
import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCatDataCache } from '@/hooks/useCatData';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

// Mock /api/cats to return dynamic cat data
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn((url: string) => {
    if (url === '/api/cats') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            cats: [
              {
                id: 'opus',
                displayName: '布偶猫',
                color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
                mentionPatterns: ['@opus'],
                clientId: 'anthropic',
                defaultModel: 'claude-opus-4-6',
                avatar: '🐱',
                roleDescription: 'test',
                personality: 'test',
              },
              {
                id: 'codex',
                displayName: '缅因猫',
                color: { primary: '#4CAF50', secondary: '#C8E6C9' },
                mentionPatterns: ['@codex'],
                clientId: 'openai',
                defaultModel: 'gpt-5.3-codex',
                avatar: '🐱',
                roleDescription: 'test',
                personality: 'test',
              },
            ],
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }),
}));

function liveExecution({
  executionId,
  catId,
  threadId = 'thread-1',
  startedAt = Date.now(),
}: {
  executionId: string;
  catId: string;
  threadId?: string;
  startedAt?: number;
}): ActiveExecutionProjection {
  return {
    executionId,
    threadId,
    threadTitle: 'Test thread',
    catId,
    kind: 'live_invocation',
    startedAt,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId, catId, executionId },
    },
  };
}

function seedExecutions(executions: ActiveExecutionProjection[], anchorThreadId = 'thread-1'): void {
  useChatStore.setState({ currentThreadId: anchorThreadId });
  useActiveExecutionStore.setState({
    anchorThreadId,
    projectPath: '/project/cafe',
    executionsByKey: Object.fromEntries(executions.map((execution) => [activeExecutionKey(execution), execution])),
    hydration: 'ready',
    hydrationError: null,
  });
}

describe('ThreadExecutionBar (F122B AC-B8 + B8/B9 polish)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(apiFetch)
      .mockReset()
      .mockImplementation((url: string) => {
        if (url === '/api/cats') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                cats: [
                  {
                    id: 'opus',
                    displayName: '布偶猫',
                    color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
                    mentionPatterns: ['@opus'],
                    clientId: 'anthropic',
                    defaultModel: 'claude-opus-4-6',
                    avatar: '🐱',
                    roleDescription: 'test',
                    personality: 'test',
                  },
                  {
                    id: 'codex',
                    displayName: '缅因猫',
                    color: { primary: '#4CAF50', secondary: '#C8E6C9' },
                    mentionPatterns: ['@codex'],
                    clientId: 'openai',
                    defaultModel: 'gpt-5.3-codex',
                    avatar: '🐱',
                    roleDescription: 'test',
                    personality: 'test',
                  },
                ],
              }),
          }) as Promise<Response>;
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as Promise<Response>;
      });
    _resetCatDataCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: 'thread-1',
      activeInvocations: {},
      hasActiveInvocation: false,
      catInvocations: {},
    });
    useActiveExecutionStore.getState().reset();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it('renders nothing when no active invocations', () => {
    act(() => root.render(React.createElement(ThreadExecutionBar)));
    expect(container.textContent).toBe('');
  });

  it('keeps no-execution hydration states out of the bottom-chrome layout', () => {
    const loadingRequest = useActiveExecutionStore.getState().beginHydration('thread-1');
    act(() => root.render(React.createElement(ThreadExecutionBar)));
    expect(container.childElementCount).toBe(0);

    useActiveExecutionStore.getState().applySnapshot('thread-1', loadingRequest, {
      projectPath: '/project/cafe',
      executions: [],
    });
    act(() => root.render(React.createElement(ThreadExecutionBar)));
    expect(container.childElementCount).toBe(0);

    const failedRequest = useActiveExecutionStore.getState().beginHydration('thread-1');
    useActiveExecutionStore.getState().failHydration('thread-1', failedRequest, new Error('offline'));
    act(() => root.render(React.createElement(ThreadExecutionBar)));
    expect(container.childElementCount).toBe(0);
  });

  it('keeps active controls and marks retained execution truth as stale after hydration fails', async () => {
    seedExecutions([liveExecution({ executionId: 'inv-stale', catId: 'opus' })]);
    const failedRequest = useActiveExecutionStore.getState().beginHydration('thread-1');
    useActiveExecutionStore.getState().failHydration('thread-1', failedRequest, new Error('offline'));

    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    expect(container.querySelector('[aria-label="Stop opus live_invocation inv-stale"]')).not.toBeNull();
    const staleMarker = container.querySelector('[data-testid="execution-hydration-stale"]');
    expect(staleMarker?.textContent).toBe('状态暂不可核对');
    expect(staleMarker?.getAttribute('title')).toBe('同步暂时失败，显示最近一次已验证状态。');
  });

  it('renders active cat with display name from cat-config', async () => {
    seedExecutions([liveExecution({ executionId: 'inv-1', catId: 'opus', startedAt: Date.now() - 5000 })]);
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('执行中');
    // Should show display name (布偶猫) not raw catId (opus)
    expect(text).toContain('布偶猫');
    expect(text).toMatch(/0:0[0-9]/);
  });

  it('renders multiple active cats with their respective display names', async () => {
    seedExecutions([
      liveExecution({ executionId: 'inv-1', catId: 'opus', startedAt: Date.now() - 30_000 }),
      liveExecution({ executionId: 'inv-2', catId: 'codex', startedAt: Date.now() - 10_000 }),
    ]);
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('布偶猫');
    expect(text).toContain('缅因猫');
  });

  it('fences rapid repeated Stop All clicks before the first REST cancels settle', async () => {
    let releaseCancel: ((response: Response) => void) | undefined;
    const cancelResponse = new Promise<Response>((resolve) => {
      releaseCancel = resolve;
    });
    const mockedApiFetch = vi.mocked(apiFetch);
    mockedApiFetch.mockImplementation((url: string) => {
      if (url === '/api/cats') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cats: [] }),
        }) as Promise<Response>;
      }
      if (url.includes('/cancel')) return cancelResponse;
      return Promise.resolve(
        new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [] }), { status: 200 }),
      );
    });
    seedExecutions([
      liveExecution({ executionId: 'inv-1', catId: 'opus' }),
      liveExecution({ executionId: 'inv-2', catId: 'codex' }),
    ]);
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const stopAll = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('全部停止'),
    );
    expect(stopAll).toBeTruthy();

    await act(async () => {
      stopAll?.click();
      stopAll?.click();
      await Promise.resolve();
    });

    const cancelCalls = mockedApiFetch.mock.calls.filter(([url]) => String(url).includes('/cancel'));
    expect(cancelCalls).toHaveLength(2);
    expect((stopAll as HTMLButtonElement).disabled).toBe(true);

    releaseCancel?.(new Response('{}', { status: 200 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('uses dynamic cat color from cat-config (not hardcoded)', async () => {
    seedExecutions([liveExecution({ executionId: 'inv-1', catId: 'codex' })]);
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const dot = container.querySelector('.animate-pulse') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.style.backgroundColor).toBe('var(--color-codex-primary)');
  });

  it('filters exact executions by thread instead of collapsing them globally by cat', async () => {
    seedExecutions([
      liveExecution({ executionId: 'inv-here', catId: 'opus' }),
      liveExecution({ executionId: 'inv-elsewhere', catId: 'opus', threadId: 'thread-2' }),
    ]);
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    const nameCount = (text.match(/布偶猫/g) ?? []).length;
    expect(nameCount).toBe(1);
  });

  it('falls back to catId when cat not in config', async () => {
    seedExecutions([liveExecution({ executionId: 'inv-1', catId: 'unknown-cat' })]);
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('unknown-cat');
  });

  it('background thread invocation has startedAt after thread switch (R1 P1-1)', async () => {
    const fiveSecondsAgo = Date.now() - 5000;
    seedExecutions(
      [liveExecution({ executionId: 'inv-bg', catId: 'codex', threadId: 'thread-bg', startedAt: fiveSecondsAgo })],
      'thread-bg',
    );
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('缅因猫');
    expect(text).not.toContain('0:00');
  });

  it('shows canonical app-server stage and last provider activity in-context', async () => {
    const now = Date.now();
    seedExecutions([liveExecution({ executionId: 'inv-1', catId: 'codex', startedAt: now - 10_000 })]);
    useChatStore.setState({
      catInvocations: {
        codex: {
          invocationId: 'inv-1',
          appServerLifecycle: {
            stage: 'active',
            lastActivityAt: now - 5_000,
            recoveryAttempt: 0,
            turnStartSent: true,
            turnAccepted: true,
            itemObserved: true,
          },
        },
      },
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    expect(container.textContent).toContain('运行回合');
    expect(container.textContent).toMatch(/活动 [45] 秒前/);
  });

  it('marks a silent active app-server turn as visible warning without auto-canceling it', async () => {
    const now = Date.now();
    seedExecutions([liveExecution({ executionId: 'inv-1', catId: 'codex', startedAt: now - 300_000 })]);
    useChatStore.setState({
      catInvocations: {
        codex: {
          invocationId: 'inv-1',
          appServerLifecycle: {
            stage: 'active',
            lastActivityAt: now - 130_000,
            recoveryAttempt: 0,
            turnStartSent: true,
            turnAccepted: true,
            itemObserved: false,
          },
        },
      },
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    expect(container.querySelector('[data-app-server-stalled="true"]')).not.toBeNull();
    expect(container.textContent).toContain('可能在等待模型');
    expect(container.querySelector('[aria-label="Stop codex live_invocation inv-1"]')).not.toBeNull();
  });
});
