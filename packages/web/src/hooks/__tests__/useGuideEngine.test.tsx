import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { useChatStore } from '@/stores/chatStore';
import { type OrchestrationFlow, useGuideStore } from '@/stores/guideStore';

const apiFetchMock = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const FLOW: OrchestrationFlow = {
  id: 'add-member',
  name: 'Add Member',
  steps: [
    { id: 'step-1', target: 'hub.trigger', tips: 'Open hub', advance: 'click' },
    { id: 'step-2', target: 'cats.add-member', tips: 'Add member', advance: 'click' },
  ],
};

const FLOW_2: OrchestrationFlow = {
  id: 'invite-reviewer',
  name: 'Invite Reviewer',
  steps: [
    { id: 'step-1', target: 'reviewers.tab', tips: 'Open reviewers', advance: 'click' },
    { id: 'step-2', target: 'reviewers.invite', tips: 'Invite reviewer', advance: 'click' },
  ],
};

const BOOTCAMP_FLOW: OrchestrationFlow = {
  id: 'bootcamp-add-teammate',
  name: 'Bootcamp Add Teammate',
  steps: [{ id: 'step-1', target: 'cats.add-member', tips: 'Add teammate', advance: 'click' }],
};

function Harness() {
  useGuideEngine();
  return null;
}

function dispatchGuideStart(flowId: string, threadId = 'thread-1') {
  useGuideStore.getState().reduceServerEvent({ action: 'start', guideId: flowId, threadId });
}

function dispatchGuideControl(action: 'next' | 'skip' | 'exit', detail: { guideId?: string; threadId?: string } = {}) {
  const guideId = detail.guideId ?? useGuideStore.getState().session?.flow.id;
  const threadId = detail.threadId ?? useGuideStore.getState().session?.threadId;
  if (!guideId || !threadId) return;
  useGuideStore.getState().reduceServerEvent({
    action: action === 'next' ? 'control_next' : action === 'skip' ? 'control_skip' : 'control_exit',
    guideId,
    threadId,
  });
}

function dispatchGuideComplete(detail: { guideId?: string; threadId?: string } = {}) {
  const guideId = detail.guideId ?? useGuideStore.getState().session?.flow.id;
  const threadId = detail.threadId ?? useGuideStore.getState().session?.threadId;
  if (!guideId || !threadId) return;
  useGuideStore.getState().reduceServerEvent({ action: 'complete', guideId, threadId });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

describe('useGuideEngine duplicate start protection', () => {
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
    apiFetchMock.mockReset();
    useChatStore.setState({ currentThreadId: 'thread-1' });
    useGuideStore.setState({ session: null, completionPersisted: false, completionFailed: false, pendingStart: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ currentThreadId: 'default' });
    useGuideStore.setState({ session: null, completionPersisted: false, completionFailed: false, pendingStart: null });
  });

  it('does not fetch the same flow twice while the first start is still in flight', async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<OrchestrationFlow> }>();
    apiFetchMock.mockReturnValue(pending.promise);

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      dispatchGuideStart('add-member');
      await Promise.resolve();
    });

    expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/guide-flows/add-member')).toHaveLength(1);

    await act(async () => {
      pending.resolve({ ok: true, json: async () => FLOW });
      await pending.promise;
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  });

  it('retries only after a new guide:start arrives when the in-flight fetch fails', async () => {
    const firstFetch = deferred<{ ok: boolean; json: () => Promise<OrchestrationFlow> }>();
    let flowFetchCount = 0;
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/guide-flows/add-member') {
        flowFetchCount += 1;
        return flowFetchCount === 1 ? firstFetch.promise : Promise.resolve({ ok: true, json: async () => FLOW });
      }
      if (url === '/api/guide-actions/start') {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
    });

    expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/guide-flows/add-member')).toHaveLength(1);

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
    });

    await act(async () => {
      firstFetch.reject(new Error('temporary failure'));
      await Promise.resolve();
    });

    expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/guide-flows/add-member')).toHaveLength(1);

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/guide-flows/add-member')).toHaveLength(2);
    expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  });

  it('does not reset the current guide when the same start event arrives again after progress', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      useGuideStore.getState().advanceStep();
    });
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
    });

    expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/guide-flows/add-member')).toHaveLength(1);
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);
  });

  it('does not start a fetched guide after the active thread changes before the flow resolves', async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<OrchestrationFlow> }>();
    apiFetchMock.mockReturnValue(pending.promise);

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member', 'thread-1');
      await Promise.resolve();
    });

    useChatStore.setState({ currentThreadId: 'thread-2' });

    await act(async () => {
      pending.resolve({ ok: true, json: async () => FLOW });
      await pending.promise;
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session).toBeNull();
  });

  it('exits an active thread-bound guide when the current thread changes away', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member', 'thread-1');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('add-member');

    await act(async () => {
      useChatStore.setState({ currentThreadId: 'thread-2' });
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session).toBeNull();
  });

  it('applies matching guide:control events to the current session', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.currentStepIndex).toBe(0);

    act(() => {
      dispatchGuideControl('next', { guideId: 'add-member', threadId: 'thread-1' });
    });
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);

    act(() => {
      dispatchGuideControl('exit', { guideId: 'add-member', threadId: 'thread-1' });
    });
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('ignores guide:control events for a different guide or thread', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      dispatchGuideControl('exit', { guideId: 'other-guide', threadId: 'thread-1' });
      dispatchGuideControl('exit', { guideId: 'add-member', threadId: 'thread-2' });
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  });

  it('marks the current session complete on a matching guide:complete event', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => FLOW }).mockResolvedValueOnce({ ok: true });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.phase).toBe('locating');

    act(() => {
      dispatchGuideComplete({ guideId: 'add-member', threadId: 'thread-1' });
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
  });

  it('does not mark completion persisted for a newer session when an older completion request resolves later', async () => {
    const completionPending = deferred<{ ok: boolean }>();
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/guide-flows/add-member') {
        return Promise.resolve({ ok: true, json: async () => FLOW });
      }
      if (url === '/api/guide-flows/invite-reviewer') {
        return Promise.resolve({ ok: true, json: async () => FLOW_2 });
      }
      if (url === '/api/guide-actions/start') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/guide-actions/complete') {
        return completionPending.promise;
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      dispatchGuideComplete({ guideId: 'add-member', threadId: 'thread-1' });
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
    expect(useGuideStore.getState().completionPersisted).toBe(false);

    await act(async () => {
      dispatchGuideStart('invite-reviewer');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('invite-reviewer');
    expect(useGuideStore.getState().completionPersisted).toBe(false);

    await act(async () => {
      completionPending.resolve({ ok: true });
      await completionPending.promise;
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('invite-reviewer');
    expect(useGuideStore.getState().completionPersisted).toBe(false);
  });

  it('marks completionFailed (not persisted) when completion POST fails after all retries', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/guide-flows/add-member') {
        return Promise.resolve({ ok: true, json: async () => FLOW });
      }
      if (url === '/api/guide-actions/start') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/guide-actions/complete') {
        return Promise.resolve({ ok: false, status: 500 });
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      dispatchGuideComplete({ guideId: 'add-member', threadId: 'thread-1' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().completionPersisted).toBe(false);
    expect(useGuideStore.getState().completionFailed).toBe(true);
  });

  it('marks completionFailed when completion POST throws after all retries', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/guide-flows/add-member') {
        return Promise.resolve({ ok: true, json: async () => FLOW });
      }
      if (url === '/api/guide-actions/start') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/guide-actions/complete') {
        return Promise.reject(new Error('network failure'));
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      dispatchGuideComplete({ guideId: 'add-member', threadId: 'thread-1' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().completionPersisted).toBe(false);
    expect(useGuideStore.getState().completionFailed).toBe(true);
  });

  it('rolls back completedGuides when completion POST fails after advanceStep reaches the end', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/guide-flows/add-member') {
        return Promise.resolve({ ok: true, json: async () => FLOW });
      }
      if (url === '/api/guide-actions/start') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/guide-actions/complete') {
        return Promise.resolve({ ok: false, status: 500 });
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      useGuideStore.getState().advanceStep();
    });
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);

    act(() => {
      useGuideStore.getState().advanceStep();
    });
    expect(useGuideStore.getState().session?.phase).toBe('complete');
    expect(useGuideStore.getState().completedGuides.has('thread-1::add-member')).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().completionFailed).toBe(true);
    expect(useGuideStore.getState().completedGuides.has('thread-1::add-member')).toBe(false);
  });

  it('merges bootcamp phase advance against fresh server state before PATCH', async () => {
    const staleState = {
      v: 1,
      phase: 'phase-7.5-add-teammate',
      startedAt: 1000,
    };
    const freshState = {
      ...staleState,
      selectedTaskId: 'Q1',
      envCheck: { node: { ok: true } },
      advancedFeatures: { tts: 'available' },
    };
    let patchBody: unknown;

    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/guide-flows/bootcamp-add-teammate') {
        return Promise.resolve({ ok: true, json: async () => BOOTCAMP_FLOW });
      }
      if (url === '/api/guide-actions/start') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/guide-actions/complete') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/threads/thread-1' && !init?.method) {
        return Promise.resolve({ ok: true, json: async () => ({ bootcampState: freshState }) });
      }
      if (url === '/api/threads/thread-1' && init?.method === 'PATCH') {
        patchBody = init.body;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            bootcampState: {
              ...freshState,
              phase: 'phase-8-collab',
              guideStep: null,
            },
          }),
        });
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    useChatStore.setState({
      currentThreadId: 'thread-1',
      threads: [
        {
          id: 'thread-1',
          projectPath: 'default',
          title: 'Bootcamp',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: 0,
          createdAt: 0,
          bootcampState: staleState,
        },
      ],
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('bootcamp-add-teammate');
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      dispatchGuideComplete({ guideId: 'bootcamp-add-teammate', threadId: 'thread-1' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.parse(String(patchBody))).toEqual({
      bootcampState: {
        ...freshState,
        phase: 'phase-8-collab',
        guideStep: null,
      },
    });
  });
});
