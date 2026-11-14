/**
 * PR-3a (docs/plans/2026-11-05-hub-pr3-background-thread-contract.md 3.5–3.7): a user-room lifecycle
 * snapshot is the background thread's "this turn ended". Writing it and alerting are separate; only
 * a snapshot the store seam marked `applied` may alert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';

const invalidateSidebarProjection = vi.fn(() => Promise.resolve(true));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: () => invalidateSidebarProjection(),
}));
vi.mock('@/hooks/useCatData', () => ({
  getCachedCats: () => [{ id: 'cat-eqdvbcxw', displayName: '缅因猫', variantLabel: 'sol' }],
}));
vi.mock('@/lib/cat-display-name', () => ({
  formatCatDisplayName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

const { __resetLifecycleAlertsForTests, lifecycleCommitOf, observeLifecycleSnapshot } = await import(
  '../agent-messages/lifecycle-terminal'
);
const { writeStoredSnapshot } = await import('../named-message-writer');

type Status = 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted';

function response(status: Status, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'resp-1',
    type: 'assistant',
    from: { kind: 'agent', catId: 'opus' },
    catId: 'opus',
    content: '完整内容。'.repeat(40),
    timestamp: 100,
    extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn-1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['source-1'],
      status,
      startedAt: 90,
      ...(status === 'processing' ? {} : { completedAt: 120 }),
      ...(status === 'failed' ? { reason: 'provider exited' } : {}),
    },
    ...overrides,
  } as ChatMessage;
}

function deliveryFailure(): ChatMessage {
  return {
    id: 'failure-1',
    type: 'system',
    variant: 'error',
    content: '没有可用成员可以处理这条消息。',
    timestamp: 100,
    lifecycle: {
      kind: 'delivery_failure',
      orderKey: '100:source-1:failure',
      status: 'failed',
      sourceEntryId: 'entry-1',
      inputMessageId: 'source-1',
      requestedTargets: [],
      reason: 'no_available_target',
      createdAt: 100,
    },
  } as ChatMessage;
}

/** What the user-room handler does: write the snapshot into the store, then observe it. */
function observe(message: ChatMessage, options: { commit?: unknown; threadId?: string } = {}) {
  const threadId = options.threadId ?? 'thread-bg';
  writeStoredSnapshot(threadId, message);
  observeLifecycleSnapshot({ threadId, message, commit: lifecycleCommitOf(options.commit) });
}

/** A record this page already holds for the message before the snapshot arrives. */
function hold(message: ChatMessage, threadId = 'thread-bg') {
  useChatStore.getState().upsertLifecycleMessage(threadId, message);
}

const toasts = () => useToastStore.getState().toasts;

describe('lifecycle snapshot: background terminal alerts', () => {
  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'thread-open', threadStates: {} });
    useToastStore.setState({ toasts: [] });
    invalidateSidebarProjection.mockClear();
    __resetLifecycleAlertsForTests();
  });

  it('alerts once for an applied completion and keeps the whole answer', () => {
    const message = response('completed');
    observe(message, { commit: 'applied' });
    observe(message, { commit: 'applied' });

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ type: 'success', title: 'opus 完成', threadId: 'thread-bg' });
    expect(toasts()[0].message).toBe(message.content);
  });

  it('projects the cached member name', () => {
    observe(response('completed', { catId: 'cat-eqdvbcxw' }), { commit: 'applied' });
    expect(toasts()[0].title).toBe('缅因猫（sol） 完成');
  });

  it('does not alert a replayed terminal, even with nothing cached here', () => {
    observe(response('completed'), { commit: 'replayed' });
    expect(toasts()).toHaveLength(0);
  });

  it('does not alert an unmarked snapshot that an exit still emits itself', () => {
    observe(response('completed'));
    expect(toasts()).toHaveLength(0);
  });

  it('alerts once whichever order the unmarked and the applied snapshot of one terminal arrive in', () => {
    // The seam resolves its owner room asynchronously, so the exit's own unmarked snapshot can
    // write the terminal into the store before the applied one lands.
    observe(response('completed'));
    expect(toasts()).toHaveLength(0);
    observe(response('completed'), { commit: 'applied' });
    observe(response('completed'), { commit: 'applied' });
    expect(toasts()).toHaveLength(1);

    observe(response('completed', { id: 'resp-2' }), { commit: 'applied' });
    observe(response('completed', { id: 'resp-2' }));
    expect(toasts()).toHaveLength(2);
  });

  it('alerts a response that so far had only streamed body and no lifecycle', () => {
    hold({ ...response('completed'), lifecycle: undefined, isStreaming: true } as ChatMessage);
    observe(response('completed'), { commit: 'applied' });
    expect(toasts()).toHaveLength(1);
  });

  it('alerts processing → failed and interrupted as errors', () => {
    hold(response('processing'));
    observe(response('failed'), { commit: 'applied' });
    observe(response('interrupted', { id: 'resp-2' }), { commit: 'applied' });

    expect(toasts().map((toast) => [toast.type, toast.title, toast.message])).toEqual([
      ['error', 'opus 出错', 'provider exited'],
      ['error', 'opus 出错', response('interrupted').content],
    ]);
  });

  it('does not alert a cancel', () => {
    hold(response('processing'));
    observe(response('canceled'), { commit: 'applied' });
    expect(toasts()).toHaveLength(0);
  });

  it('alerts an applied delivery failure', () => {
    observe(deliveryFailure(), { commit: 'applied' });
    expect(toasts()).toEqual([
      expect.objectContaining({ type: 'error', title: '出错', message: '没有可用成员可以处理这条消息。' }),
    ]);
  });

  it('does not alert the open thread but still refreshes the Sidebar', () => {
    observe(response('completed'), { commit: 'applied', threadId: 'thread-open' });
    expect(toasts()).toHaveLength(0);
    expect(invalidateSidebarProjection).toHaveBeenCalledOnce();
  });

  it('refreshes the Sidebar on any terminal, marked or not, and never on processing', () => {
    observe(response('processing'), { commit: 'applied' });
    expect(invalidateSidebarProjection).not.toHaveBeenCalled();

    observe(response('completed'));
    observe(deliveryFailure(), { commit: 'replayed' });
    expect(invalidateSidebarProjection).toHaveBeenCalledTimes(2);
  });
});

describe('lifecycle snapshot: background slot ending', () => {
  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'thread-open', threadStates: {} });
    useToastStore.setState({ toasts: [] });
    invalidateSidebarProjection.mockClear();
    __resetLifecycleAlertsForTests();
  });

  it('ends the slot this turn held and leaves a newer turn of the same cat alone', () => {
    const store = useChatStore.getState();
    store.addThreadActiveInvocation('thread-bg', 'parent-1', 'opus', 'execute', 90);
    store.addThreadActiveInvocation('thread-bg', 'parent-2', 'opus', 'execute', 130);

    observe(response('completed'), { commit: 'applied' });

    const slots = useChatStore.getState().getThreadState('thread-bg').activeInvocations;
    expect(Object.keys(slots ?? {})).toEqual(['parent-2']);
  });

  it('leaves the hydrated placeholder of a newer run when an older run ends', () => {
    // Reconnect hydration stood the cat's current run up as a placeholder; catInvocations names it.
    const store = useChatStore.getState();
    store.addThreadActiveInvocation('thread-bg', 'hydrated-opus', 'opus', 'execute', 300);
    store.setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'parent-2', turnInvocationId: 'turn-2' });

    // An old run's terminal, as a replay repair, an unmarked exit snapshot, or even a fresh commit.
    observe(response('completed'), { commit: 'replayed' });
    observe(response('completed', { id: 'resp-1b' }));
    observe(response('failed', { id: 'resp-1c' }), { commit: 'applied' });

    const thread = useChatStore.getState().getThreadState('thread-bg');
    expect(Object.keys(thread.activeInvocations ?? {})).toEqual(['hydrated-opus']);
    expect(thread.catInvocations.opus).toMatchObject({ invocationId: 'parent-2', turnInvocationId: 'turn-2' });
    // Ending the slot and alerting are separate: a fresh commit of the old run still alerts.
    expect(toasts()).toHaveLength(1);
    expect(invalidateSidebarProjection).toHaveBeenCalledTimes(3);
  });

  it('still sweeps the placeholder when catInvocations names this very turn', () => {
    const store = useChatStore.getState();
    store.addThreadActiveInvocation('thread-bg', 'hydrated-opus', 'opus', 'execute', 300);
    store.setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'parent-1', turnInvocationId: 'turn-1' });

    observe(response('completed'), { commit: 'replayed' });

    const thread = useChatStore.getState().getThreadState('thread-bg');
    expect(Object.keys(thread.activeInvocations ?? {})).toEqual([]);
    expect(thread.catInvocations.opus?.invocationId).toBeUndefined();
  });

  it('ends nothing when the snapshot carries no parent liveness id', () => {
    const store = useChatStore.getState();
    store.addThreadActiveInvocation('thread-bg', 'parent-2', 'opus', 'execute', 130);

    observe(response('completed', { extra: {} }), { commit: 'applied' });

    expect(Object.keys(useChatStore.getState().getThreadState('thread-bg').activeInvocations ?? {})).toEqual([
      'parent-2',
    ]);
  });
});
