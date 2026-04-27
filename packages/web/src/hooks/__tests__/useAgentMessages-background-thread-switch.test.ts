/**
 * F173 AC-B4 Phase B-3 fixture — thread switch ghost-bubble regression.
 *
 * Establishes regression coverage for the thread-switch race window before
 * Phase C lands its hydration rewrite. Phase C will rewire the read path
 * through ThreadRuntimeWriter; these fixtures ensure that rewrite cannot
 * silently break:
 *   1. background events for non-current threads route to threadStates,
 *      never the flat (current-thread) state
 *   2. concurrent streams across two threads stay isolated under switch
 *   3. terminal events that arrive after a switch finalize the correct
 *      thread's bubble without polluting the now-current thread
 *
 * Mechanism: drive {@link handleBackgroundAgentMessage} against the real
 * `useChatStore`, mirroring the pattern in `useAgentMessages.test.ts`
 * but isolated to the thread-switch race surface (not the full handler
 * matrix).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configureDebug } from '@/debug/invocationEventDebug';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { resetSharedReplacedInvocations } from '../shared-replaced-invocations';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage } from '../useAgentMessages';

let bgSeq = 0;
const bgStreamRefs = new Map<string, { id: string; threadId: string; catId: string }>();
const finalizedBgRefs = new Map<string, string>();

function simulate(msg: BackgroundAgentMessage) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    bgStreamRefs,
    finalizedBgRefs,
    nextBgSeq: () => bgSeq++,
    addToast: (toast) => useToastStore.getState().addToast(toast),
    clearDoneTimeout: () => {},
  });
}

describe('F173 AC-B4 — thread switch ghost-bubble fixture', () => {
  beforeEach(() => {
    configureDebug({ enabled: false });
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-a',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
    useToastStore.setState({ toasts: [] });
    bgSeq = 0;
    bgStreamRefs.clear();
    finalizedBgRefs.clear();
    resetSharedReplacedInvocations();
  });

  it('stream chunk for non-current thread updates threadStates only, never flat', () => {
    const now = Date.now();
    // Seed thread-a bubble while it is current
    useChatStore.getState().addMessageToThread('thread-a', {
      id: 'bubble-a',
      type: 'assistant',
      catId: 'opus',
      content: 'hello',
      timestamp: now,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-a' } },
    });

    // User switches away to thread-b — flat snapshot moves to thread-b's empty state
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().currentThreadId).toBe('thread-b');
    expect(useChatStore.getState().messages).toHaveLength(0);

    // Stream chunk for thread-a arrives after switch
    simulate({
      type: 'text',
      catId: 'opus',
      threadId: 'thread-a',
      content: ' world',
      timestamp: now + 1,
      invocationId: 'inv-a',
    });

    const tsA = useChatStore.getState().getThreadState('thread-a');
    expect(tsA.messages).toHaveLength(1);
    expect(tsA.messages[0].id).toBe('bubble-a');
    expect(tsA.messages[0].content).toBe('hello world');

    // Flat (now reflects thread-b) must not have absorbed thread-a's bubble
    const flat = useChatStore.getState();
    expect(flat.currentThreadId).toBe('thread-b');
    expect(flat.messages).toHaveLength(0);
  });

  it('concurrent streams in two threads stay isolated across switch', () => {
    const now = Date.now();
    // Two pre-existing streaming bubbles, one per thread
    useChatStore.getState().addMessageToThread('thread-a', {
      id: 'bubble-a',
      type: 'assistant',
      catId: 'opus',
      content: 'A:',
      timestamp: now,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-a' } },
    });
    useChatStore.getState().addMessageToThread('thread-b', {
      id: 'bubble-b',
      type: 'assistant',
      catId: 'opus',
      content: 'B:',
      timestamp: now,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-b' } },
    });

    useChatStore.getState().setCurrentThread('thread-b');

    // Interleave background events for both threads
    simulate({
      type: 'text',
      catId: 'opus',
      threadId: 'thread-a',
      content: ' aaa',
      timestamp: now + 1,
      invocationId: 'inv-a',
    });
    simulate({
      type: 'text',
      catId: 'opus',
      threadId: 'thread-b',
      content: ' bbb',
      timestamp: now + 2,
      invocationId: 'inv-b',
    });
    simulate({
      type: 'text',
      catId: 'opus',
      threadId: 'thread-a',
      content: ' aaa2',
      timestamp: now + 3,
      invocationId: 'inv-a',
    });

    const tsA = useChatStore.getState().getThreadState('thread-a');
    const tsB = useChatStore.getState().getThreadState('thread-b');

    expect(tsA.messages).toHaveLength(1);
    expect(tsA.messages[0].id).toBe('bubble-a');
    expect(tsA.messages[0].content).toBe('A: aaa aaa2');

    expect(tsB.messages).toHaveLength(1);
    expect(tsB.messages[0].id).toBe('bubble-b');
    expect(tsB.messages[0].content).toBe('B: bbb');
  });

  it('done event for previous thread after switch finalizes that thread, not the current one', () => {
    const now = Date.now();
    useChatStore.getState().addMessageToThread('thread-a', {
      id: 'bubble-a',
      type: 'assistant',
      catId: 'opus',
      content: 'hello',
      timestamp: now,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-a' } },
    });
    useChatStore.getState().updateThreadCatStatus('thread-a', 'opus', 'streaming');

    // Real-world flow: a stream chunk binds bgStreamRefs to the bubble first;
    // without this, stopTrackedStream() short-circuits and never finalizes
    // the bubble — so a fixture without this step would silently green even
    // if the done path stopped calling setThreadMessageStreaming(false).
    simulate({
      type: 'text',
      catId: 'opus',
      threadId: 'thread-a',
      content: ' more',
      timestamp: now + 1,
      invocationId: 'inv-a',
    });
    expect(bgStreamRefs.get('thread-a::opus')?.id).toBe('bubble-a');

    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().currentThreadId).toBe('thread-b');

    simulate({
      type: 'done',
      catId: 'opus',
      threadId: 'thread-a',
      timestamp: now + 2,
      invocationId: 'inv-a',
    });

    const tsA = useChatStore.getState().getThreadState('thread-a');
    expect(tsA.catStatuses.opus).toBe('done');
    // Critical: bubble must be fully finalized (not just status flipped to done).
    // stopTrackedStream() must have called setThreadMessageStreaming(false) and
    // cleared bgStreamRefs. AC-B4's terminal correctness lives here.
    expect(tsA.messages[0].isStreaming).toBe(false);
    expect(bgStreamRefs.get('thread-a::opus')).toBeUndefined();

    // Current (thread-b) flat catStatuses must not have been touched
    const flatCatStatuses = useChatStore.getState().catStatuses;
    expect(flatCatStatuses.opus).toBeUndefined();
  });
});
