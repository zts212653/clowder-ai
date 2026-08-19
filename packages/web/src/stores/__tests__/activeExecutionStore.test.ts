import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeExecutionKey, useActiveExecutionStore } from '../activeExecutionStore';
import { DEFAULT_THREAD_STATE, useChatStore } from '../chatStore';

function live(executionId: string, startedAt: number): ActiveExecutionProjection {
  return {
    executionId,
    threadId: 'thread-a',
    threadTitle: 'Alpha',
    catId: 'kimi',
    kind: 'live_invocation',
    startedAt,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: 'thread-a', catId: 'kimi', executionId },
    },
  };
}

function command(): ActiveExecutionProjection {
  return {
    executionId: 'hold-ball-command',
    threadId: 'thread-b',
    threadTitle: 'Background',
    catId: 'kimi',
    kind: 'managed_command',
    startedAt: 200,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'managed_command', taskId: 'hold-ball-command' },
    },
  };
}

function response(executions: ActiveExecutionProjection[]): ActiveExecutionListResponse {
  return { projectPath: '/project/cafe', executions };
}

describe('F295 activeExecutionStore', () => {
  beforeEach(() => useActiveExecutionStore.getState().reset());

  it('retires only identities absent from the newest canonical snapshot', () => {
    const firstRequest = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore
      .getState()
      .applySnapshot('thread-a', firstRequest, response([live('inv-old', 100), command()]));

    const secondRequest = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore
      .getState()
      .applySnapshot('thread-a', secondRequest, response([live('inv-new', 300), command()]));

    const byKey = useActiveExecutionStore.getState().executionsByKey;
    expect(byKey[activeExecutionKey(live('inv-old', 100))]).toBeUndefined();
    expect(byKey[activeExecutionKey(live('inv-new', 300))]?.executionId).toBe('inv-new');
    expect(byKey[activeExecutionKey(command())]?.kind).toBe('managed_command');
  });

  it('ignores a late response from an older refresh so it cannot erase a replacement', () => {
    const oldRequest = useActiveExecutionStore.getState().beginHydration('thread-a');
    const newRequest = useActiveExecutionStore.getState().beginHydration('thread-a');

    useActiveExecutionStore.getState().applySnapshot('thread-a', newRequest, response([live('inv-new', 300)]));
    useActiveExecutionStore.getState().applySnapshot('thread-a', oldRequest, response([live('inv-old', 100)]));

    expect(Object.values(useActiveExecutionStore.getState().executionsByKey).map((item) => item.executionId)).toEqual([
      'inv-new',
    ]);
  });

  it('keeps the last verified display state during a same-anchor background refresh', () => {
    const initial = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', initial, response([]));

    useActiveExecutionStore.getState().beginHydration('thread-a');

    expect(useActiveExecutionStore.getState().hydration).toBe('ready');
    expect(useActiveExecutionStore.getState().executionsByKey).toEqual({});
  });

  it('keeps a managed command visible after the model invocation reaches terminal', () => {
    const initial = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', initial, response([live('inv-a', 100), command()]));

    const terminal = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', terminal, response([command()]));

    expect(Object.values(useActiveExecutionStore.getState().executionsByKey)).toEqual([command()]);
  });

  it('does not mutate unread truth while executions hydrate or retire', () => {
    useChatStore.setState({
      threadStates: {
        'thread-b': { ...DEFAULT_THREAD_STATE, unreadCount: 3, hasUserMention: true },
      },
    });
    const request = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', request, response([command()]));
    const terminal = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', terminal, response([]));

    expect(useChatStore.getState().threadStates['thread-b']?.unreadCount).toBe(3);
    expect(useChatStore.getState().threadStates['thread-b']?.hasUserMention).toBe(true);
  });

  it('fences one exact cancellation until a canonical snapshot retires it', () => {
    const execution = live('inv-cancel', 100);
    const initial = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', initial, response([execution]));

    expect(useActiveExecutionStore.getState().beginCancellation(execution)).toBe(true);
    expect(useActiveExecutionStore.getState().beginCancellation(execution)).toBe(false);

    useActiveExecutionStore.getState().settleCancellation(execution);
    const key = activeExecutionKey(execution);
    expect(useActiveExecutionStore.getState().executionsByKey[key]).toBeUndefined();
    expect(useActiveExecutionStore.getState().cancelPendingByKey[key]).toBe(true);

    const terminalizing = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', terminalizing, response([execution]));
    expect(useActiveExecutionStore.getState().executionsByKey[key]).toEqual(execution);
    expect(useActiveExecutionStore.getState().cancelPendingByKey[key]).toBe(true);

    const terminal = useActiveExecutionStore.getState().beginHydration('thread-a');
    useActiveExecutionStore.getState().applySnapshot('thread-a', terminal, response([]));
    expect(useActiveExecutionStore.getState().cancelPendingByKey[key]).toBeUndefined();
  });
});
