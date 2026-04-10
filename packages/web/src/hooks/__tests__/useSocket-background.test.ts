/**
 * P1-2 + P2 regression tests for background thread socket message handling.
 *
 * Since useSocket is a React hook with socket.io dependency,
 * we test the background message processing logic at the store level
 * by simulating what the socket handler should do.
 *
 * We extract the expected behavior from useSocket and verify the store actions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configureDebug, dumpBubbleTimeline, ensureWindowDebugApi } from '@/debug/invocationEventDebug';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import {
  type BackgroundAgentMessage,
  clearBackgroundStreamRefForActiveEvent,
  handleBackgroundAgentMessage,
} from '../useSocket-background';

/** Monotonic counter matching useSocket.ts bgSeq */
let testBgSeq = 0;
const testBgStreamRefs = new Map<string, { id: string; threadId: string; catId: string }>();
const testBgReplacedInvocations = new Map<string, string>();
const testBgFinalizedRefs = new Map<string, string>();

/** #80 fix-C: Track clearDoneTimeout calls */
let clearDoneTimeoutCalls: Array<string | undefined> = [];

/**
 * Runs the extracted background-thread branch handler with real stores.
 */
function simulateBackgroundMessage(msg: {
  type: string;
  catId: string;
  threadId: string;
  content?: string;
  messageId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
  isFinal?: boolean;
  metadata?: { provider: string; model: string; sessionId?: string };
  origin?: 'stream' | 'callback';
  invocationId?: string;
  timestamp: number;
}) {
  handleBackgroundAgentMessage(msg as BackgroundAgentMessage, {
    store: useChatStore.getState(),
    bgStreamRefs: testBgStreamRefs,
    finalizedBgRefs: testBgFinalizedRefs,
    replacedInvocations: testBgReplacedInvocations,
    nextBgSeq: () => testBgSeq++,
    addToast: (toast) => useToastStore.getState().addToast(toast),
    clearDoneTimeout: (threadId) => {
      clearDoneTimeoutCalls.push(threadId);
    },
  });
}

describe('background thread socket handling', () => {
  beforeEach(() => {
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
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
      currentThreadId: 'thread-active',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
    useToastStore.setState({ toasts: [] });
    testBgSeq = 0;
    testBgStreamRefs.clear();
    testBgFinalizedRefs.clear();
    testBgReplacedInvocations.clear();
    clearDoneTimeoutCalls = [];
  });

  describe('P1-2: done event handling', () => {
    it('done event updates cat status to done', () => {
      // First set streaming status
      useChatStore.getState().updateThreadCatStatus('thread-bg', 'opus', 'streaming');

      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.catStatuses.opus).toBe('done');
    });

    it('done event fires success toast', () => {
      simulateBackgroundMessage({
        type: 'done',
        catId: 'codex',
        threadId: 'thread-bg',
        timestamp: Date.now(),
      });

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].type).toBe('success');
      expect(toasts[0].title).toBe('codex 完成');
      expect(toasts[0].threadId).toBe('thread-bg');
    });

    it('text with isFinal also transitions to done', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        isFinal: true,
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.catStatuses.opus).toBe('done');
    });
  });

  describe('P1-3 (R2): error must not be overwritten by done', () => {
    it('done after error preserves error status', () => {
      // Backend sends error then done
      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg',
        error: 'something broke',
        timestamp: Date.now(),
      });
      // Status should be error
      expect(useChatStore.getState().getThreadState('thread-bg').catStatuses.opus).toBe('error');

      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        timestamp: Date.now(),
      });

      // Status must still be error, NOT done
      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.catStatuses.opus).toBe('error');
    });

    it('done after error does not emit success toast', () => {
      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg',
        error: 'fail',
        timestamp: Date.now(),
      });
      // 1 error toast
      expect(useToastStore.getState().toasts).toHaveLength(1);
      expect(useToastStore.getState().toasts[0].type).toBe('error');

      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        timestamp: Date.now(),
      });

      // Should still be just 1 toast (the error), no success toast added
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  describe('R2-P2: text(isFinal) clears hasActiveInvocation', () => {
    it('non-final background stream marks thread as loading and active', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'still running',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.isLoading).toBe(true);
      expect(ts.hasActiveInvocation).toBe(true);
    });

    it('background text with isFinal clears hasActiveInvocation for that thread', () => {
      // Set up: switch to thread-bg, mark active invocation, switch away
      useChatStore.getState().setCurrentThread('thread-bg');
      useChatStore.getState().setHasActiveInvocation(true);
      useChatStore.getState().setLoading(true);
      // Switch back to thread-active — thread-bg gets snapshotted with hasActiveInvocation=true
      useChatStore.getState().setCurrentThread('thread-active');
      expect(useChatStore.getState().threadStates['thread-bg']?.hasActiveInvocation).toBe(true);
      expect(useChatStore.getState().threadStates['thread-bg']?.isLoading).toBe(true);

      // Simulate background text(isFinal)
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        isFinal: true,
        timestamp: Date.now(),
      });

      // hasActiveInvocation should be cleared
      expect(useChatStore.getState().threadStates['thread-bg']?.hasActiveInvocation).toBe(false);
      expect(useChatStore.getState().threadStates['thread-bg']?.isLoading).toBe(false);
    });

    it('callback-origin text does not mark background thread invocation active by itself', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'callback note',
        origin: 'callback',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.isLoading).toBe(false);
      expect(ts.hasActiveInvocation).toBe(false);
    });

    it('callback-origin text preserves backend messageId for exact history reconciliation', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'callback note',
        origin: 'callback',
        messageId: 'msg-callback-1',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('msg-callback-1');
      expect(ts.messages[0]?.origin).toBe('callback');
    });

    it('callback-origin text replaces overlapping background stream bubble from the same invocation', () => {
      const now = Date.now();
      useChatStore.getState().setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'inv-bg-1' });
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'bg-stream-1',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        origin: 'stream',
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-bg-1' } },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        origin: 'callback',
        messageId: 'bg-callback-1',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toEqual([
        expect.objectContaining({
          id: 'bg-callback-1',
          catId: 'opus',
          content: 'final answer',
          origin: 'callback',
          isStreaming: false,
          extra: { stream: { invocationId: 'inv-bg-1' } },
        }),
      ]);
    });

    it('callback-origin text replaces a finalized background stream bubble from the same invocation', () => {
      const now = Date.now();
      useChatStore.getState().setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'inv-bg-2' });
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'bg-stream-final',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        origin: 'stream',
        isStreaming: false,
        extra: { stream: { invocationId: 'inv-bg-2' } },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        origin: 'callback',
        messageId: 'bg-callback-final',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toEqual([
        expect.objectContaining({
          id: 'bg-callback-final',
          catId: 'opus',
          content: 'final answer',
          origin: 'callback',
          isStreaming: false,
          extra: { stream: { invocationId: 'inv-bg-2' } },
        }),
      ]);
    });

    it('drops late background stream chunks after callback replacement', () => {
      configureDebug({ enabled: true });
      ensureWindowDebugApi();

      const now = Date.now();
      useChatStore.getState().setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'inv-bg-3' });
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'bg-stream-3',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        origin: 'stream',
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-bg-3' } },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        origin: 'callback',
        messageId: 'bg-callback-3',
        timestamp: now + 1,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' late chunk',
        origin: 'stream',
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toEqual([
        expect.objectContaining({
          id: 'bg-callback-3',
          catId: 'opus',
          content: 'final answer',
          origin: 'callback',
          isStreaming: false,
        }),
      ]);

      expect(dumpBubbleTimeline({ rawThreadId: true }).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'bubble_lifecycle',
            threadId: 'thread-bg',
            action: 'drop',
            reason: 'late_stream_after_callback_replace',
            catId: 'opus',
            invocationId: 'inv-bg-3',
            origin: 'stream',
          }),
        ]),
      );
    });

    it('keeps suppressing unlabeled background late chunks until a different invocation is observed', () => {
      const now = Date.now();
      useChatStore.getState().setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'inv-bg-old' });
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'bg-stream-old',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        origin: 'stream',
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-bg-old' } },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        origin: 'callback',
        messageId: 'bg-callback-old',
        timestamp: now + 1,
      });

      useChatStore.getState().setThreadCatInvocation('thread-bg', 'opus', { invocationId: undefined });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'stale unlabeled chunk from old invocation',
        origin: 'stream',
        timestamp: now + 2,
      });

      expect(useChatStore.getState().getThreadState('thread-bg').messages).toEqual([
        expect.objectContaining({
          id: 'bg-callback-old',
          catId: 'opus',
          content: 'final answer',
          origin: 'callback',
          isStreaming: false,
        }),
      ]);

      useChatStore.getState().setThreadCatInvocation('thread-bg', 'opus', { invocationId: 'inv-bg-new' });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'verified new invocation first chunk',
        origin: 'stream',
        timestamp: now + 3,
      });

      expect(useChatStore.getState().getThreadState('thread-bg').messages).toEqual([
        expect.objectContaining({
          id: 'bg-callback-old',
          catId: 'opus',
          content: 'final answer',
          origin: 'callback',
          isStreaming: false,
        }),
        expect.objectContaining({
          type: 'assistant',
          catId: 'opus',
          content: 'verified new invocation first chunk',
          origin: 'stream',
          isStreaming: true,
        }),
      ]);
    });
  });

  describe('P2: message ID uniqueness', () => {
    it('same timestamp but different cats still create separate messages', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'chunk 1',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'chunk 2',
        timestamp: now, // Same ms!
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      // Different cats should produce different messages even with same timestamp
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0].content).toBe('chunk 1');
      expect(ts.messages[1].content).toBe('chunk 2');
    });
  });

  describe('F148: context briefing system_info', () => {
    it('stores the briefing card message instead of a raw JSON system bubble', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'context_briefing',
          messageId: 'briefing-msg-1',
          storedMessage: {
            id: 'briefing-msg-1',
            content: '看到 13 条 · 省略 8 条 · 锚点 3 条 · 记忆 5 sessions · 证据 3 条',
            origin: 'briefing',
            timestamp: now,
            extra: {
              rich: {
                v: 1,
                blocks: [
                  {
                    id: 'briefing-1',
                    kind: 'card',
                    v: 1,
                    title: '看到 13 条 · 省略 8 条 · 锚点 3 条 · 记忆 5 sessions · 证据 3 条',
                    tone: 'info',
                  },
                ],
              },
            },
          },
        }),
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toEqual([
        expect.objectContaining({
          id: 'briefing-msg-1',
          type: 'system',
          content: '看到 13 条 · 省略 8 条 · 锚点 3 条 · 记忆 5 sessions · 证据 3 条',
          origin: 'briefing',
          extra: {
            rich: {
              v: 1,
              blocks: [
                expect.objectContaining({
                  id: 'briefing-1',
                  kind: 'card',
                  title: '看到 13 条 · 省略 8 条 · 锚点 3 条 · 记忆 5 sessions · 证据 3 条',
                }),
              ],
            },
          },
        }),
      ]);
    });

    it('falls back to the raw system message when briefing payload is incomplete', () => {
      const now = Date.now();
      const rawBriefing = JSON.stringify({
        type: 'context_briefing',
        messageId: 'briefing-msg-2',
        storedMessage: {
          content: 'briefing without id should not be swallowed',
          origin: 'briefing',
          timestamp: now,
        },
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: rawBriefing,
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]).toEqual(
        expect.objectContaining({
          type: 'system',
          content: rawBriefing,
          variant: 'info',
        }),
      );
    });
  });

  describe('regression: background stream chunk merging', () => {
    it('merges text chunks from same cat/thread into one assistant message', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: '你',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: '好',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].content).toBe('你好');
    });

    it('multi-chunk with final chunk closes streaming and keeps merged content', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: '你',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: '好',
        timestamp: now + 1,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: '呀',
        isFinal: true,
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].content).toBe('你好呀');
      expect(ts.messages[0].isStreaming).toBe(false);
      expect(testBgStreamRefs.has('thread-bg::opus')).toBe(false);
    });

    it('error during streaming clears ref and stops existing stream message', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'partial',
        timestamp: now,
      });

      const streamKey = 'thread-bg::opus';
      const messageId = testBgStreamRefs.get(streamKey)?.id;
      expect(messageId).toBeDefined();

      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg',
        error: 'oops',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      const merged = ts.messages.find((m) => m.id === messageId);
      expect(merged?.isStreaming).toBe(false);
      const errorMsg = ts.messages.find((m) => m.type === 'system' && m.content.includes('Error: oops'));
      expect(errorMsg?.variant).toBe('error');
      expect(testBgStreamRefs.has(streamKey)).toBe(false);
    });

    it('active non-terminal event must not clear background ref needed by later background done', () => {
      const now = Date.now();
      const streamKey = 'thread-bg::opus';

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'partial',
        timestamp: now,
      });

      const messageId = testBgStreamRefs.get(streamKey)?.id;
      expect(messageId).toBeDefined();

      // Simulate thread became active and received non-terminal text chunk.
      clearBackgroundStreamRefForActiveEvent(
        {
          type: 'text',
          catId: 'opus',
          threadId: 'thread-bg',
        },
        testBgStreamRefs,
      );

      // Switch away again; terminal done is now handled by background branch.
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      const merged = ts.messages.find((m) => m.id === messageId);
      expect(merged?.isStreaming).toBe(false);
      expect(testBgStreamRefs.has(streamKey)).toBe(false);
    });

    it('active non-final error must not clear background ref before terminal background event', () => {
      const now = Date.now();
      const streamKey = 'thread-bg::opus';

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'partial',
        timestamp: now,
      });

      const messageId = testBgStreamRefs.get(streamKey)?.id;
      expect(messageId).toBeDefined();

      clearBackgroundStreamRefForActiveEvent(
        {
          type: 'error',
          catId: 'opus',
          threadId: 'thread-bg',
          isFinal: false,
        },
        testBgStreamRefs,
      );

      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      const merged = ts.messages.find((m) => m.id === messageId);
      expect(merged?.isStreaming).toBe(false);
      expect(testBgStreamRefs.has(streamKey)).toBe(false);
    });

    it('active terminal event clears stale ref and prevents next invocation merge', () => {
      const now = Date.now();
      const streamKey = 'thread-bg::codex';

      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'partial',
        timestamp: now,
      });
      expect(testBgStreamRefs.has(streamKey)).toBe(true);
      const firstMessageId = testBgStreamRefs.get(streamKey)?.id;
      expect(firstMessageId).toBeDefined();

      // Simulate active-thread terminal event consumed by active path.
      // In production, the active handler's done processing also sets isStreaming=false
      // (via findStreamingMessageId → setStreaming(ref.id, false)).
      clearBackgroundStreamRefForActiveEvent(
        {
          type: 'done',
          catId: 'codex',
          threadId: 'thread-bg',
        },
        testBgStreamRefs,
      );
      // Simulate what the active handler does: mark the message as no longer streaming
      useChatStore.getState().setThreadMessageStreaming('thread-bg', firstMessageId!, false);

      expect(testBgStreamRefs.has(streamKey)).toBe(false);

      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'new invocation',
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      const first = ts.messages.find((m) => m.id === firstMessageId);
      const second = ts.messages.find((m) => m.id !== firstMessageId);
      expect(ts.messages).toHaveLength(2);
      expect(first?.content).toBe('partial');
      expect(second?.content).toBe('new invocation');
    });
  });

  describe('regression: preserve non-text events in background path', () => {
    it('preserves tool_use as collapsed tool event on assistant message', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A', 'B'] },
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.content).toBe('');
      expect(ts.messages[0]?.toolEvents).toHaveLength(1);
      expect(ts.messages[0]?.toolEvents?.[0]?.type).toBe('tool_use');
      expect(ts.messages[0]?.toolEvents?.[0]?.label).toContain('opus → TodoWrite');
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('preserves tool_result as collapsed tool event on assistant message', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'line-1\nline-2',
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.content).toBe('');
      expect(ts.messages[0]?.toolEvents).toHaveLength(1);
      expect(ts.messages[0]?.toolEvents?.[0]?.type).toBe('tool_result');
      expect(ts.messages[0]?.toolEvents?.[0]?.label).toContain('opus ← result');
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('tool_use + tool_result merge into one assistant message with two tool events', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A', 'B'] },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'ok',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.toolEvents).toHaveLength(2);
      expect(ts.messages[0]?.toolEvents?.[0]?.type).toBe('tool_use');
      expect(ts.messages[0]?.toolEvents?.[1]?.type).toBe('tool_result');
    });

    it('web_search system_info adopts existing streaming assistant on active→background transition', () => {
      const now = Date.now();

      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'existing-stream-msg',
        type: 'assistant',
        catId: 'codex',
        content: '',
        timestamp: now - 1,
        isStreaming: true,
        origin: 'stream',
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'codex',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'web_search',
          catId: 'codex',
          count: 1,
        }),
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'updated chunk',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      const assistantMessages = ts.messages.filter((m) => m.type === 'assistant' && m.catId === 'codex');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]?.id).toBe('existing-stream-msg');
      expect(assistantMessages[0]?.content).toBe('updated chunk');
      expect(assistantMessages[0]?.toolEvents).toHaveLength(1);
      expect(assistantMessages[0]?.toolEvents?.[0]?.label).toContain('web_search');
      expect(testBgStreamRefs.get('thread-bg::codex')?.id).toBe('existing-stream-msg');
    });

    it('preserves system_info and a2a_handoff messages with info variant', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'system hint',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'a2a_handoff',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'handoff info',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0]?.content).toContain('system hint');
      expect(ts.messages[1]?.content).toContain('handoff info');
      expect(ts.messages[0]?.variant).toBe('info');
      expect(ts.messages[1]?.variant).toBe('info');
    });

    it('applies correct variant for parsed visible system_info events', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'codex',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'mode_switch_proposal',
          proposedBy: '缅因猫',
          proposedMode: 'execute',
        }),
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'session_seal_requested',
          catId: 'opus',
          sessionSeq: 3,
          healthSnapshot: { fillRatio: 0.42 },
        }),
        timestamp: now + 1,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'codex',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'a2a_followup_available',
          mentions: [{ catId: 'opus', mentionedBy: '缅因猫' }],
        }),
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(3);
      expect(ts.messages[0]?.variant).toBe('info');
      expect(ts.messages[1]?.variant).toBe('info');
      expect(ts.messages[2]?.variant).toBe('a2a_followup');
      expect(ts.messages[2]?.content).toContain('缅因猫 @了 opus');
    });

    it('consumes invocation_usage system_info into thread invocation + message metadata (no raw JSON message)', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'thinking',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 160123, outputTokens: 1589, cacheReadTokens: 114738, costUsd: 0.57 },
        }),
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.metadata?.usage).toMatchObject({
        inputTokens: 160123,
        outputTokens: 1589,
        cacheReadTokens: 114738,
        costUsd: 0.57,
      });
      expect(ts.catInvocations.opus?.usage).toMatchObject({
        inputTokens: 160123,
        outputTokens: 1589,
        cacheReadTokens: 114738,
        costUsd: 0.57,
      });
    });

    it('binds metadata+usage when tool event arrives before first text chunk', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A'] },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'hello',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6', sessionId: 'sess-tool-first' },
        timestamp: now + 1,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 321, outputTokens: 12, cacheReadTokens: 300 },
        }),
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.metadata).toMatchObject({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        sessionId: 'sess-tool-first',
      });
      expect(ts.messages[0]?.metadata?.usage).toMatchObject({
        inputTokens: 321,
        outputTokens: 12,
        cacheReadTokens: 300,
      });
    });

    it('does not backfill invocation_usage onto stale historical assistant message', () => {
      const now = Date.now();
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'hist-msg-1',
        type: 'assistant',
        catId: 'opus',
        content: 'old answer',
        metadata: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          usage: { inputTokens: 111, outputTokens: 22 },
        },
        timestamp: now - 1000,
      });

      // New invocation emits usage-only system_info without any active background message ref.
      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 999, outputTokens: 1 },
        }),
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      // Historical message usage should remain unchanged (no stale backfill).
      expect(ts.messages[0]?.metadata?.usage).toMatchObject({
        inputTokens: 111,
        outputTokens: 22,
      });
      // Invocation-level usage still updates.
      expect(ts.catInvocations.opus?.usage).toMatchObject({
        inputTokens: 999,
        outputTokens: 1,
      });
    });

    it('consumes invocation_metrics/context_health system_info silently', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'invocation_metrics',
          kind: 'session_started',
          sessionId: 'sess-1',
          invocationId: 'inv-1',
          sessionSeq: 3,
        }),
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'context_health',
          catId: 'opus',
          health: {
            usedTokens: 59342,
            windowTokens: 200000,
            fillRatio: 0.29671,
            source: 'exact',
            measuredAt: now,
          },
        }),
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(0);
      expect(ts.catInvocations.opus?.sessionId).toBe('sess-1');
      expect(ts.catInvocations.opus?.invocationId).toBe('inv-1');
      expect(ts.catInvocations.opus?.sessionSeq).toBe(3);
      expect(ts.catInvocations.opus?.contextHealth).toMatchObject({
        usedTokens: 59342,
        windowTokens: 200000,
      });
    });

    it('consumes rate_limit system_info silently (no raw JSON system bubble)', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'rate_limit',
          catId: 'opus',
          utilization: 0.91,
          resetsAt: '2026-02-28T12:00:00Z',
        }),
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(0);
      expect(ts.catInvocations.opus?.rateLimit).toMatchObject({
        utilization: 0.91,
        resetsAt: '2026-02-28T12:00:00Z',
      });
    });

    it('consumes compact_boundary system_info silently (no raw JSON system bubble)', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'compact_boundary',
          catId: 'opus',
          preTokens: 42000,
        }),
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(0);
      expect(ts.catInvocations.opus?.compactBoundary).toMatchObject({ preTokens: 42000 });
    });

    it('consumes context_health without catId via message catId fallback', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'context_health',
          health: {
            usedTokens: 8123,
            windowTokens: 200000,
            fillRatio: 0.0406,
            source: 'exact',
            measuredAt: now,
          },
        }),
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(0);
      expect(ts.catInvocations.opus?.contextHealth).toMatchObject({
        usedTokens: 8123,
        windowTokens: 200000,
      });
    });
  });

  describe('active→background transition: bubble recovery', () => {
    it('text(stream) after thread switch recovers existing streaming bubble instead of creating new one', () => {
      const now = Date.now();
      // Simulate: active phase created a streaming bubble, then user switched away
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'active-bubble-1',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        timestamp: now,
        isStreaming: true,
        origin: 'stream',
      });

      // First background text event should recover the existing bubble
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' more thoughts',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('active-bubble-1');
      expect(ts.messages[0].content).toBe('thinking... more thoughts');
      // bgStreamRef should now be set for future events
      expect(testBgStreamRefs.get('thread-bg::opus')?.id).toBe('active-bubble-1');
    });

    it('records bubble timeline when background path recovers a lost stream ref', () => {
      const now = Date.now();
      configureDebug({ enabled: true });
      ensureWindowDebugApi();

      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'active-bubble-debug',
        type: 'assistant',
        catId: 'opus',
        content: 'thinking...',
        timestamp: now,
        isStreaming: true,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-bg-1' } },
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' recovered',
        timestamp: now + 1,
      });

      const debugApi = (
        window as typeof window & {
          __catCafeDebug?: { dumpBubbleTimeline?: (options?: { rawThreadId?: boolean }) => string };
        }
      ).__catCafeDebug;
      const dump = JSON.parse(debugApi!.dumpBubbleTimeline!({ rawThreadId: true })) as {
        events: Array<Record<string, unknown>>;
      };

      expect(dump.events).toContainEqual(
        expect.objectContaining({
          event: 'bubble_lifecycle',
          threadId: 'thread-bg',
          action: 'recover',
          reason: 'background_ref_lost',
          catId: 'opus',
          messageId: 'active-bubble-debug',
          invocationId: 'inv-bg-1',
          origin: 'stream',
        }),
      );
    });

    it('tool_use after thread switch recovers existing streaming bubble', () => {
      const now = Date.now();
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'active-bubble-2',
        type: 'assistant',
        catId: 'opus',
        content: '',
        timestamp: now,
        isStreaming: true,
        origin: 'stream',
      });

      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        toolName: 'Read',
        toolInput: { path: '/foo.ts' },
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('active-bubble-2');
      expect(ts.messages[0].toolEvents).toHaveLength(1);
      expect(ts.messages[0].toolEvents?.[0].type).toBe('tool_use');
      expect(testBgStreamRefs.get('thread-bg::opus')?.id).toBe('active-bubble-2');
    });

    it('tool_result after thread switch recovers existing streaming bubble', () => {
      const now = Date.now();
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'active-bubble-3',
        type: 'assistant',
        catId: 'opus',
        content: '',
        timestamp: now,
        isStreaming: true,
        origin: 'stream',
      });

      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'file contents here',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('active-bubble-3');
      expect(ts.messages[0].toolEvents).toHaveLength(1);
      expect(ts.messages[0].toolEvents?.[0].type).toBe('tool_result');
    });

    it('full sequence: active bubble → switch → bg tool events → text(isFinal) all in one bubble', () => {
      const now = Date.now();
      // Active phase left a streaming bubble
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'active-bubble-full',
        type: 'assistant',
        catId: 'opus',
        content: 'let me check...',
        timestamp: now,
        isStreaming: true,
        origin: 'stream',
      });

      // Background: tool_use
      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        toolName: 'Read',
        toolInput: { path: '/foo.ts' },
        timestamp: now + 1,
      });

      // Background: tool_result
      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'file contents',
        timestamp: now + 2,
      });

      // Background: more thinking text
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' I see the issue.',
        timestamp: now + 3,
      });

      // Background: text(isFinal)
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' Fixed!',
        isFinal: true,
        timestamp: now + 4,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      // All events should be in the single recovered bubble
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('active-bubble-full');
      expect(ts.messages[0].content).toBe('let me check... I see the issue. Fixed!');
      expect(ts.messages[0].toolEvents).toHaveLength(2);
      expect(ts.messages[0].isStreaming).toBe(false);
      // bgStreamRef should be cleared after isFinal
      expect(testBgStreamRefs.has('thread-bg::opus')).toBe(false);
    });

    it('no streaming bubble → creates new one as before (no false recovery)', () => {
      const now = Date.now();
      // Add a non-streaming historical message — should NOT be recovered
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'old-msg',
        type: 'assistant',
        catId: 'opus',
        content: 'old answer',
        timestamp: now - 1000,
        isStreaming: false,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'new invocation',
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0].id).toBe('old-msg');
      expect(ts.messages[1].content).toBe('new invocation');
      expect(ts.messages[1].id).not.toBe('old-msg');
    });

    it('different cat streaming bubble is not recovered by wrong cat', () => {
      const now = Date.now();
      // Codex has a streaming bubble
      useChatStore.getState().addMessageToThread('thread-bg', {
        id: 'codex-bubble',
        type: 'assistant',
        catId: 'codex',
        content: 'codex thinking',
        timestamp: now,
        isStreaming: true,
      });

      // Opus event should NOT recover codex's bubble
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'opus thinking',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0].id).toBe('codex-bubble');
      expect(ts.messages[0].content).toBe('codex thinking');
      expect(ts.messages[1].catId).toBe('opus');
    });
  });

  describe('#80 fix-C: background done(isFinal) clears timeout guard', () => {
    it('done(isFinal) calls clearDoneTimeout with threadId', () => {
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        isFinal: true,
        timestamp: Date.now(),
      });

      expect(clearDoneTimeoutCalls).toEqual(['thread-bg']);
    });

    it('done(non-final) does NOT call clearDoneTimeout', () => {
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        timestamp: Date.now(),
      });

      expect(clearDoneTimeoutCalls).toEqual([]);
    });

    it('text(isFinal) calls clearDoneTimeout with threadId', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'final answer',
        isFinal: true,
        timestamp: Date.now(),
      });

      expect(clearDoneTimeoutCalls).toEqual(['thread-bg']);
    });

    it('error(isFinal) calls clearDoneTimeout with threadId', () => {
      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg',
        error: 'something broke',
        isFinal: true,
        timestamp: Date.now(),
      });

      expect(clearDoneTimeoutCalls).toEqual(['thread-bg']);
    });

    it('error(non-final) does NOT call clearDoneTimeout', () => {
      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg',
        error: 'partial error',
        timestamp: Date.now(),
      });

      expect(clearDoneTimeoutCalls).toEqual([]);
    });
  });

  describe('update-storm prevention: batchStreamChunkUpdate', () => {
    it('batch merges content + metadata + streaming + catStatus in one update', () => {
      const now = Date.now();
      // First chunk creates the message
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'first',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now,
      });

      // Second chunk uses batchStreamChunkUpdate (existing message path)
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' second',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].content).toBe('first second');
      expect(ts.messages[0].isStreaming).toBe(true);
      expect(ts.messages[0].metadata?.provider).toBe('anthropic');
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('batch handles high-frequency chunks without state corruption', () => {
      const now = Date.now();
      // Simulate 50 rapid chunks (the kind that triggers React update depth)
      for (let i = 0; i < 50; i++) {
        simulateBackgroundMessage({
          type: 'text',
          catId: 'opus',
          threadId: 'thread-bg',
          content: `c${i}`,
          timestamp: now + i,
        });
      }

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      // All 50 chunks should be merged
      const expected = Array.from({ length: 50 }, (_, i) => `c${i}`).join('');
      expect(ts.messages[0].content).toBe(expected);
      expect(ts.messages[0].isStreaming).toBe(true);
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('batch final chunk sets streaming=false and catStatus=done', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'start',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: ' end',
        isFinal: true,
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages[0].content).toBe('start end');
      expect(ts.messages[0].isStreaming).toBe(false);
      expect(ts.catStatuses.opus).toBe('done');
    });
  });

  describe('F108: slot-aware background invocation tracking', () => {
    it('seeds a new background stream bubble with invocationId from activeInvocations when catInvocations is still empty', () => {
      useChatStore.getState().addThreadActiveInvocation('thread-bg', 'inv-slot-1', 'opus', 'execute');

      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        toolName: 'command_execution',
        toolInput: { command: 'git status' },
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]).toMatchObject({
        type: 'assistant',
        catId: 'opus',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-slot-1' } },
      });
    });

    it('markThreadInvocationActive registers invocationId when available', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'hello',
        invocationId: 'inv-1',
        timestamp: Date.now(),
      });
      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.hasActiveInvocation).toBe(true);
      expect(ts.activeInvocations['inv-1']).toEqual(expect.objectContaining({ catId: 'opus', mode: 'execute' }));
    });

    it('markThreadInvocationComplete removes specific invocationId, preserves others', () => {
      // Activate two invocations
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        content: 'a',
        invocationId: 'inv-1',
        timestamp: Date.now(),
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        content: 'b',
        invocationId: 'inv-2',
        timestamp: Date.now(),
      });

      let ts = useChatStore.getState().getThreadState('thread-bg');
      expect(Object.keys(ts.activeInvocations)).toHaveLength(2);

      // Complete inv-1 (opus done, codex still running)
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        content: '',
        isFinal: true,
        invocationId: 'inv-1',
        timestamp: Date.now(),
      });

      ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.activeInvocations['inv-1']).toBeUndefined();
      expect(ts.activeInvocations['inv-2']).toEqual(expect.objectContaining({ catId: 'codex', mode: 'execute' }));
      expect(ts.hasActiveInvocation).toBe(true);

      // Complete inv-2 → all clear
      simulateBackgroundMessage({
        type: 'done',
        catId: 'codex',
        threadId: 'thread-bg',
        content: '',
        isFinal: true,
        invocationId: 'inv-2',
        timestamp: Date.now(),
      });

      ts = useChatStore.getState().getThreadState('thread-bg');
      expect(Object.keys(ts.activeInvocations)).toHaveLength(0);
      expect(ts.hasActiveInvocation).toBe(false);
    });

    it('catA cancel (done without invocationId) does not clear catB active slot', () => {
      // Two cats running concurrently on background thread
      useChatStore.getState().addThreadActiveInvocation('thread-bg', 'inv-opus', 'opus', 'execute');
      useChatStore.getState().addThreadActiveInvocation('thread-bg', 'inv-codex', 'codex', 'execute');
      let ts = useChatStore.getState().getThreadState('thread-bg');
      expect(Object.keys(ts.activeInvocations)).toHaveLength(2);

      // Steer cancels opus — done(isFinal) arrives without invocationId
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        isFinal: true,
        timestamp: Date.now(),
        // No invocationId — this is the cancel broadcast path
      });

      // codex slot must survive
      ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.activeInvocations['inv-codex']).toEqual(expect.objectContaining({ catId: 'codex', mode: 'execute' }));
      expect(ts.activeInvocations['inv-opus']).toBeUndefined();
      expect(ts.hasActiveInvocation).toBe(true); // codex still active
    });
  });
});
