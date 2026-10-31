import { beforeEach, describe, expect, it } from 'vitest';
import type { Thread } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { syncLocalBootcampState } from '../syncLocalBootcampState';

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: 'default',
    title: null,
    createdBy: 'user',
    participants: [],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('syncLocalBootcampState', () => {
  beforeEach(() => {
    useChatStore.setState({
      threads: [
        makeThread({
          id: 'thread-1',
          bootcampState: { v: 1, phase: 'phase-7.5-add-teammate', guideStep: 'open-hub', startedAt: 1 },
        }),
        makeThread({ id: 'thread-2' }),
      ],
    });
  });

  it('updates bootcampState for the target thread only', () => {
    syncLocalBootcampState('thread-1', {
      v: 1,
      phase: 'phase-7.5-add-teammate',
      guideStep: 'click-add-member',
      startedAt: 1,
    });

    const state = useChatStore.getState();
    expect(state.threads.find((thread) => thread.id === 'thread-1')?.bootcampState).toMatchObject({
      guideStep: 'click-add-member',
    });
    expect(state.threads.find((thread) => thread.id === 'thread-2')?.bootcampState).toBeUndefined();
  });
});
