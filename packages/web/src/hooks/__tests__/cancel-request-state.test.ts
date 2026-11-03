import { beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { handleActiveAgentMessage } from '../agent-messages/active-handler';
import { handleBackgroundAgentMessage } from '../useAgentMessages';

beforeEach(() => {
  useChatStore.setState({
    currentThreadId: 'open',
    messages: [],
    threadStates: {},
    activeInvocations: {},
    catInvocations: {},
    catStatuses: {},
    hasActiveInvocation: false,
    isLoading: false,
    intentMode: null,
  });
});

const request = { type: 'status', catId: 'codex', content: '正在停止，等待执行状态确认', timestamp: 1 };

it('the open-thread consumer keeps the real execution/loading until the actual terminal', () => {
  const store = useChatStore.getState();
  store.addActiveInvocation('inv', 'codex', 'execute');
  store.setLoading(true);
  store.setCatStatus('codex', 'streaming');
  const context = {
    actions: store,
    rows: { rows: () => [], addRow: vi.fn(), patchRow: vi.fn(), removeRow: vi.fn() },
    resolveCatName: (id: string) => id,
    timeoutDiagnostics: { set: vi.fn(), take: () => null },
  };
  handleActiveAgentMessage({ ...request, threadId: 'open' }, context);
  expect(useChatStore.getState().activeInvocations.inv?.catId).toBe('codex');
  expect(useChatStore.getState().hasActiveInvocation).toBe(true);
  expect(useChatStore.getState().isLoading).toBe(true);
  expect(useChatStore.getState().catStatuses.codex).toBe('streaming');
  handleActiveAgentMessage(
    { type: 'done', catId: 'codex', threadId: 'open', invocationId: 'inv', isFinal: true, timestamp: 2 },
    context,
  );
  expect(useChatStore.getState().activeInvocations).toEqual({});
  expect(useChatStore.getState().hasActiveInvocation).toBe(false);
  expect(useChatStore.getState().isLoading).toBe(false);
});

it('the background-thread consumer also retains the real slot until the actual terminal', () => {
  const store = useChatStore.getState();
  store.addThreadActiveInvocation('background', 'inv', 'codex', 'execute');
  store.setThreadLoading('background', true);
  const context = { store, nextBgSeq: () => 1, addToast: vi.fn() };
  handleBackgroundAgentMessage({ ...request, threadId: 'background' }, context);
  const stopping = store.getThreadState('background');
  expect(stopping.activeInvocations.inv?.catId).toBe('codex');
  expect(stopping.hasActiveInvocation).toBe(true);
  expect(stopping.isLoading).toBe(true);
  handleBackgroundAgentMessage(
    { type: 'done', catId: 'codex', threadId: 'background', invocationId: 'inv', isFinal: true, timestamp: 2 },
    context,
  );
  expect(store.getThreadState('background').activeInvocations).toEqual({});
  expect(store.getThreadState('background').hasActiveInvocation).toBe(false);
  expect(store.getThreadState('background').isLoading).toBe(false);
});

// The payload shape is produced by the real degraded Fastify recovery path.
const failedTerminal = {
  type: 'done',
  catId: 'opus5',
  invocationId: 'parent',
  turnInvocationId: 'failed-child',
  isFinal: true,
  errorCode: 'control_plane_unavailable',
  timestamp: 2,
};

for (const sibling of [false, true])
  it(`failed recovery remains failed in background; live sibling=${sibling}`, () => {
    const store = useChatStore.getState();
    store.addThreadActiveInvocation('background', 'parent', 'opus5', 'execute');
    store.setThreadCatInvocation('background', 'opus5', { invocationId: 'parent', turnInvocationId: 'failed-child' });
    if (sibling) {
      store.addThreadActiveInvocation('background', 'parent-kimi', 'kimi', 'execute');
      store.setThreadCatInvocation('background', 'kimi', { invocationId: 'parent', turnInvocationId: 'live-child' });
    }
    store.updateThreadCatStatus('background', 'opus5', 'streaming');
    store.setThreadLoading('background', true);
    const addToast = vi.fn();
    handleBackgroundAgentMessage(
      { ...failedTerminal, threadId: 'background' },
      { store, nextBgSeq: () => 1, addToast },
    );
    const after = store.getThreadState('background');
    expect(after.isLoading).toBe(sibling);
    expect(after.hasActiveInvocation).toBe(sibling);
    // The established last-slot teardown clears status badges; the failure toast must survive it.
    if (sibling) expect(after.catStatuses.opus5).toBe('error');
    expect(addToast.mock.calls.some(([toast]) => toast.type === 'success')).toBe(false);
    expect(addToast.mock.calls.some(([toast]) => toast.type === 'error')).toBe(true);
    if (sibling) expect(after.activeInvocations['parent-kimi']?.catId).toBe('kimi');
  });

it('the open-thread failed terminal also preserves a sibling and presents failure', () => {
  const store = useChatStore.getState();
  store.addActiveInvocation('parent', 'opus5', 'execute');
  store.addActiveInvocation('parent-kimi', 'kimi', 'execute');
  store.setCatInvocation('opus5', { invocationId: 'parent', turnInvocationId: 'failed-child' });
  store.setCatInvocation('kimi', { invocationId: 'parent', turnInvocationId: 'live-child' });
  store.setLoading(true);
  handleActiveAgentMessage(
    { ...failedTerminal, threadId: 'open' },
    {
      actions: store,
      rows: { rows: () => [], addRow: vi.fn(), patchRow: vi.fn(), removeRow: vi.fn() },
      resolveCatName: (id: string) => id,
      timeoutDiagnostics: { set: vi.fn(), take: () => null },
    },
  );
  expect(useChatStore.getState().activeInvocations['parent-kimi']?.catId).toBe('kimi');
  expect(useChatStore.getState().isLoading).toBe(true);
  expect(useChatStore.getState().catStatuses.opus5).toBe('error');
});
