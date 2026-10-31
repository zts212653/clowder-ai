import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

vi.mock('@/hooks/useThreadScopedSelectors', () => ({ useThreadLiveness: () => ({ hasActive: true }) }));

import { useExecutionRecoveryVerification } from '../useExecutionRecoveryVerification';

it('does not treat an unavailable project as verified idle even when it is the current anchor', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const store = useActiveExecutionStore.getState();
  store.reset();
  store.applySnapshot('thread-a', store.beginHydration('thread-a', '/cafe'), {
    scope: 'all',
    executions: [],
    unavailableProjectPaths: ['/cafe'],
  });
  useChatStore.setState({
    threads: [
      {
        id: 'thread-a',
        title: 'A',
        createdBy: 'default-user',
        projectPath: '/cafe',
        participants: [],
        createdAt: 1,
        lastActiveAt: 1,
        pinned: false,
      },
    ],
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    const result = useExecutionRecoveryVerification('thread-a');
    return (
      <output>
        {JSON.stringify({ ready: result.canonicalProjectionReady, unverified: result.hasUnverifiedLegacyExecution })}
      </output>
    );
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(JSON.parse(host.textContent ?? '{}')).toEqual({ ready: false, unverified: true });
    await act(async () =>
      store.applySnapshot('thread-a', store.beginHydration('thread-a', '/cafe'), {
        scope: 'all',
        executions: [],
        unavailableProjectPaths: ['/planet'],
      }),
    );
    expect(JSON.parse(host.textContent ?? '{}')).toEqual({ ready: true, unverified: false });
  } finally {
    act(() => root.unmount());
    store.reset();
    vi.unstubAllGlobals();
  }
});
