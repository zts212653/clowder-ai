import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useExecutionRecoveryVerification } from '@/hooks/useExecutionRecoveryVerification';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

/**
 * The verification answer must be identical for every surface that asks, and it
 * must key on the same execution semantics the cancel/recovery surfaces use.
 * Callers used to supply the canonical count themselves and immediately diverged.
 */
let observed: ReturnType<typeof useExecutionRecoveryVerification> | null = null;

function Probe({ threadId, unscoped }: { threadId?: string; unscoped?: boolean }) {
  observed = useExecutionRecoveryVerification(threadId, unscoped);
  return null;
}

function setLegacyActive() {
  useChatStore.setState({
    currentThreadId: 'thread-a',
    activeInvocations: { 'inv-a': { catId: 'opus', mode: 'execute', startedAt: 1000 } },
    hasActiveInvocation: true,
    catStatuses: { opus: 'streaming' },
    catInvocations: {},
    threadStates: {},
  });
}

function hydrateWith(kind: 'live_invocation' | 'managed_command') {
  const request = useActiveExecutionStore.getState().beginHydration('thread-a');
  useActiveExecutionStore.getState().applySnapshot('thread-a', request, {
    projectPath: '/project/cafe',
    executions: [
      {
        executionId: 'exec-1',
        threadId: 'thread-a',
        threadTitle: 'Alpha',
        catId: 'opus',
        kind,
        startedAt: 1000,
        cancelability: { state: 'not_cancelable', reason: 'control_plane_unavailable' },
      },
    ],
  });
}

describe('useExecutionRecoveryVerification', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    useActiveExecutionStore.getState().reset();
    observed = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("uses the caller's unscoped prop rather than the raw store flag when they disagree", () => {
    // The store says nothing is running; the container's prop says something is.
    useChatStore.setState({
      currentThreadId: 'thread-a',
      activeInvocations: {},
      hasActiveInvocation: false,
      catStatuses: {},
      catInvocations: {},
      threadStates: {},
    });

    act(() => {
      root.render(React.createElement(Probe, { unscoped: true }));
    });
    expect(observed?.hasUnverifiedLegacyExecution).toBe(true);

    act(() => {
      root.render(React.createElement(Probe, { unscoped: false }));
    });
    expect(observed?.hasUnverifiedLegacyExecution).toBe(false);
  });

  it('trusts a settled canonical snapshot even when it lists no live invocation', () => {
    setLegacyActive();
    hydrateWith('managed_command');
    act(() => {
      root.render(React.createElement(Probe, { threadId: 'thread-a' }));
    });
    // Hydration is ready, so an empty live list is authoritative, not "unverified".
    expect(observed?.hasUnverifiedLegacyExecution).toBe(false);
  });

  it('ignores non-live executions when the snapshot is NOT settled', () => {
    // This is where the two surfaces used to disagree: ThreadExecutionBar counted
    // every execution kind while ChatInput counted live invocations only, so a
    // retained managed_command on a stale snapshot produced two different answers
    // to the same question. The count now lives inside the hook.
    setLegacyActive();
    hydrateWith('managed_command');
    act(() => {
      useActiveExecutionStore
        .getState()
        .failHydration('thread-a', useActiveExecutionStore.getState().requestVersion, new Error('sync down'));
    });
    act(() => {
      root.render(React.createElement(Probe, { threadId: 'thread-a' }));
    });

    expect(observed?.canonicalProjectionStale).toBe(true);
    expect(observed?.hasUnverifiedLegacyExecution).toBe(true);
  });
});
