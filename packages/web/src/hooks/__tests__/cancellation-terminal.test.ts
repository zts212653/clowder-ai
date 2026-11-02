import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_THREAD_STATE } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import type { ActiveContext } from '../agent-messages/active-context';
import { handleActiveDone } from '../agent-messages/active-terminal';
import { handleBackgroundAgentMessage } from '../agent-messages/background-handler';
import type { BackgroundAgentMessage } from '../agent-messages/types';

const cleanup: BackgroundAgentMessage = {
  type: 'done',
  catId: 'gemini',
  threadId: 'thread',
  invocationId: 'parent',
  turnInvocationId: 'turn',
  messageId: 'response',
  errorCode: 'INVOCATION_CANCELLED',
  isFinal: true,
  timestamp: 1,
};
function seed(owner = 'parent', turn = 'turn') {
  return {
    ...structuredClone(DEFAULT_THREAD_STATE),
    isLoading: true,
    hasActiveInvocation: true,
    activeInvocations: { [owner]: { catId: 'gemini', mode: 'execute' } },
    catInvocations: { gemini: { invocationId: owner, turnInvocationId: turn } },
    catStatuses: { gemini: 'streaming' as const },
    messages: [
      {
        id: 'response',
        type: 'assistant' as const,
        catId: 'gemini',
        content: 'partial',
        timestamp: 1,
        isStreaming: true,
        lifecycle: {
          kind: 'response' as const,
          orderKey: '1:turn',
          invocationId: 'turn',
          targetId: 'gemini',
          inputEntryIds: [],
          inputMessageIds: [],
          startedAt: 1,
          completedAt: 2,
          status: 'canceled' as const,
          reason: 'user_cancel',
        },
      },
    ],
  };
}
function background(msg: BackgroundAgentMessage) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    nextBgSeq: () => 1,
    addToast: (toast) => useToastStore.getState().addToast(toast),
  });
}
function context(): ActiveContext {
  const s = useChatStore.getState();
  return {
    actions: s,
    rows: {
      rows: () => useChatStore.getState().messages,
      addRow: s.addMessage,
      patchRow: s.patchMessage,
      removeRow: s.removeMessage,
    },
    resolveCatName: (id) => id,
    timeoutDiagnostics: { take: () => null, set: () => {} },
  };
}
beforeEach(() => {
  useChatStore.setState({ ...seed(), currentThreadId: 'thread', threadStates: {} });
  useToastStore.setState({ toasts: [] });
});
it('canceled cleanup and a normal routing terminal produce no success toast or duplicate row', () => {
  useChatStore.setState({ currentThreadId: 'other', threadStates: { thread: seed() } });
  background(cleanup);
  background({ ...cleanup, errorCode: undefined });
  expect(useToastStore.getState().toasts).toHaveLength(0);
  const state = useChatStore.getState().getThreadState('thread');
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0].content).toBe('partial');
  expect(state.messages[0].lifecycle).toMatchObject({ status: 'canceled' });
  expect(state.activeInvocations).toEqual({});
});
it.each(['active', 'background'])('late owned or anonymous cancellation cannot clear a new %s owner', (path) => {
  const next = seed('new-parent', 'new-turn');
  if (path === 'active') useChatStore.setState(next);
  else useChatStore.setState({ currentThreadId: 'other', threadStates: { thread: next } });
  for (const msg of [
    cleanup,
    { ...cleanup, invocationId: undefined, turnInvocationId: undefined, messageId: undefined },
  ]) {
    if (path === 'active') handleActiveDone(msg, 'thread', context());
    else background(msg);
  }
  const state = path === 'active' ? useChatStore.getState() : useChatStore.getState().getThreadState('thread');
  expect(Object.keys(state.activeInvocations)).toEqual(['new-parent']);
  expect(state.isLoading).toBe(true);
  expect(state.catStatuses.gemini).toBe('streaming');
});
it.each(['active', 'background'])('anonymous cancellation still retires a %s hydrated orphan', (path) => {
  const orphan = { ...seed('hydrated-gemini'), catInvocations: {} };
  if (path === 'active') useChatStore.setState(orphan);
  else useChatStore.setState({ currentThreadId: 'other', threadStates: { thread: orphan } });
  const msg = { ...cleanup, invocationId: undefined, turnInvocationId: undefined, messageId: undefined };
  if (path === 'active') handleActiveDone(msg, 'thread', context());
  else background(msg);
  const state = path === 'active' ? useChatStore.getState() : useChatStore.getState().getThreadState('thread');
  expect(state.activeInvocations).toEqual({});
  expect(state.isLoading).toBe(false);
  expect(useToastStore.getState().toasts).toHaveLength(0);
});
it('ordinary successful terminal still notifies once', () => {
  const state = seed();
  state.messages = [];
  useChatStore.setState({ currentThreadId: 'other', threadStates: { thread: state } });
  background({ ...cleanup, errorCode: undefined, messageId: undefined });
  expect(useToastStore.getState().toasts).toHaveLength(1);
});

it.each(['active', 'background'])('lock-only recovery retires the exact real %s orphan', (path) => {
  const msg = { ...cleanup, messageId: undefined };
  if (path === 'background') useChatStore.setState({ currentThreadId: 'other', threadStates: { thread: seed() } });
  if (path === 'active') handleActiveDone(msg, 'thread', context());
  else background(msg);
  const state = path === 'active' ? useChatStore.getState() : useChatStore.getState().getThreadState('thread');
  expect(state.activeInvocations).toEqual({});
  expect(state.isLoading).toBe(false);
  expect(useToastStore.getState().toasts).toHaveLength(0);
});

it('Codex completed status before done still produces one successful terminal notification', () => {
  const state = { ...seed(), messages: [], catStatuses: { gemini: 'done' as const } };
  useChatStore.setState({ currentThreadId: 'other', threadStates: { thread: state } });
  const terminal = { ...cleanup, errorCode: undefined };
  background(terminal);
  background(terminal);
  expect(useToastStore.getState().toasts).toHaveLength(1);
});
