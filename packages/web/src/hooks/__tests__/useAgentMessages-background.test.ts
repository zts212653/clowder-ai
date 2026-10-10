/**
 * P1-2 + P2 regression tests for background thread socket message handling.
 *
 * Since useSocket is a React hook with socket.io dependency,
 * we test the background message processing logic at the store level
 * by simulating what the socket handler should do.
 *
 * We extract the expected behavior from useSocket and verify the store actions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage } from '../useAgentMessages';
import { selectThreadLiveness } from '../useThreadScopedSelectors';

/** Monotonic counter matching useSocket.ts bgSeq */
let testBgSeq = 0;

/**
 * Runs the extracted background-thread branch handler with real stores.
 */
function simulateBackgroundMessage(msg: BackgroundAgentMessage, resolveCatName?: (catId: string) => string) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    nextBgSeq: () => testBgSeq++,
    addToast: (toast) => useToastStore.getState().addToast(toast),
    resolveCatName,
  });
}

/** Seeds a turn's processing response the way its lifecycle snapshot would, before any output. */
function seedProcessingResponse(threadId: string, id: string, catId: string, content: string, timestamp: number) {
  useChatStore.getState().addMessageToThread(threadId, {
    id,
    type: 'assistant',
    catId,
    content,
    origin: 'stream',
    isStreaming: true,
    timestamp,
    lifecycle: {
      kind: 'response',
      orderKey: `${timestamp}:inv-${id}`,
      invocationId: `inv-${id}`,
      targetId: catId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: timestamp,
    },
  });
}

describe('background thread socket handling', () => {
  beforeEach(() => {
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

    it('projects the runtime member name in background completion toasts', () => {
      simulateBackgroundMessage(
        {
          type: 'done',
          catId: 'cat-eqdvbcxw',
          threadId: 'thread-bg',
          timestamp: Date.now(),
        },
        () => '缅因猫（sol）',
      );

      const [toast] = useToastStore.getState().toasts;
      expect(toast.title).toBe('缅因猫（sol） 完成');
      expect(toast.message).toBe('缅因猫（sol） 已完成处理');
    });

    it('text with isFinal also transitions to done', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'final answer',
        isFinal: true,
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.catStatuses.opus).toBe('done');
    });

    it('done ends a background raw stream; the committed snapshot carries the canonical persisted content', () => {
      const raw = '@co-creator 原始流式正文 [跳过去 R1｜目标｜0123456789ab]';
      const canonical = '原始流式正文 跳过去 R1';
      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex-sol',
        threadId: 'thread-bg',
        invocationId: 'inv-bg-concierge',
        messageId: 'resp-1',
        content: raw,
        origin: 'stream',
        timestamp: Date.now(),
      });

      simulateBackgroundMessage({
        type: 'done',
        catId: 'codex-sol',
        threadId: 'thread-bg',
        invocationId: 'inv-bg-concierge',
        messageId: 'resp-1',
        content: canonical,
        isFinal: true,
        timestamp: Date.now() + 1,
      });

      // done only stops streaming; it never writes the body (its content duplicates the commit).
      expect(useChatStore.getState().getThreadState('thread-bg').messages).toEqual([
        expect.objectContaining({ id: 'resp-1', content: raw, isStreaming: false }),
      ]);

      // The committed response published at the target's done is the final truth.
      useChatStore.getState().upsertLifecycleMessage('thread-bg', {
        id: 'resp-1',
        type: 'assistant',
        catId: 'codex-sol',
        content: canonical,
        timestamp: Date.now(),
        lifecycle: {
          kind: 'response',
          orderKey: '1:inv-bg-concierge',
          invocationId: 'inv-bg-concierge',
          targetId: 'codex-sol',
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
        },
      });
      expect(useChatStore.getState().getThreadState('thread-bg').messages).toEqual([
        expect.objectContaining({ id: 'resp-1', content: canonical, isStreaming: false }),
      ]);
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

    // F183 Phase B1.7 (砚砚 R1 P1) regression: an error without messageId (no admitted
    // response, e.g. preflight/registration failure) keeps its own error row; on a
    // non-current thread the sidebar unread badge must count it, otherwise it stays 0.
    it('B1.7 砚砚 R1 P1: bg error row without messageId increments unread for non-current thread', () => {
      // bg thread = thread-bg；current thread = thread-active。
      simulateBackgroundMessage({
        type: 'error',
        catId: 'codex',
        threadId: 'thread-bg',
        invocationId: 'inv-1',
        error: 'Provider 500',
        timestamp: Date.now(),
        isFinal: true,
      });
      const ts = useChatStore.getState().getThreadState('thread-bg');
      // error row with its own id
      expect(ts.messages.some((m) => m.type === 'system' && (m as { variant?: string }).variant === 'error')).toBe(
        true,
      );
      // unread badge 必须 +1
      expect(ts.unreadCount).toBe(1);
    });

    // F212 Phase B 云端 codex P2-4 (2026-05-27): bg-thread error must also propagate
    // metadata.cliDiagnostics into bubble.extra so the folded panel renders. Without
    // this fix, CLI failures in a non-foreground thread fall back to legacy red-pill.
    it('F212 Phase B (P2-4): bg error wires metadata.cliDiagnostics into bubble.extra', () => {
      const diag = {
        reasonCode: 'auth_failed' as const,
        publicSummary: 'API 认证失败',
        publicHint: '检查 API key',
        debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'inv-bg-cli' },
      };
      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg-cli',
        invocationId: 'inv-bg-cli',
        error: 'CLI exit 1',
        timestamp: Date.now(),
        isFinal: true,
        metadata: { provider: 'anthropic', model: 'claude-opus', cliDiagnostics: diag },
      });
      const ts = useChatStore.getState().getThreadState('thread-bg-cli');
      const errBubble = ts.messages.find((m) => m.type === 'system' && (m as { variant?: string }).variant === 'error');
      expect(errBubble).toBeTruthy();
      expect(errBubble?.extra?.cliDiagnostics).toEqual(diag);
    });

    // F212 Phase B 云端 codex P2-4: an invocationless bg error row must also include extra.cliDiagnostics.
    it('F212 Phase B (P2-4): invocationless bg error row also wires cliDiagnostics into extra', () => {
      const diag = {
        reasonCode: 'network_error' as const,
        publicSummary: '网络连接失败',
        publicHint: '检查代理 / VPN',
        debugRef: { command: 'codex', exitCode: 1, signal: null },
      };
      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg-cli-2',
        // no invocationId and no messageId
        error: 'CLI exit 1',
        timestamp: Date.now(),
        isFinal: true,
        metadata: { provider: 'anthropic', model: 'claude-opus', cliDiagnostics: diag },
      });
      const ts = useChatStore.getState().getThreadState('thread-bg-cli-2');
      const errBubble = ts.messages.find((m) => m.type === 'system' && (m as { variant?: string }).variant === 'error');
      expect(errBubble).toBeTruthy();
      expect(errBubble?.extra?.cliDiagnostics).toEqual(diag);
    });

    // F183 Phase B1.7 (砚砚 R1 P1) regression: a repeated error for the same invocation
    // updates its one error row — no second row, no second unread.
    it('B1.7 砚砚 R1 P1: bg duplicate error same invocation does NOT double-increment unread', () => {
      simulateBackgroundMessage({
        type: 'error',
        catId: 'codex',
        threadId: 'thread-bg-2',
        invocationId: 'inv-dup',
        error: 'first',
        timestamp: Date.now(),
        isFinal: false,
      });
      simulateBackgroundMessage({
        type: 'error',
        catId: 'codex',
        threadId: 'thread-bg-2',
        invocationId: 'inv-dup',
        error: 'second update',
        timestamp: Date.now() + 100,
        isFinal: true,
      });
      const ts = useChatStore.getState().getThreadState('thread-bg-2');
      // 仍只有 1 条 error row
      expect(
        ts.messages.filter((m) => m.type === 'system' && (m as { variant?: string }).variant === 'error'),
      ).toHaveLength(1);
      // unread 仅 +1 (not 2)
      expect(ts.unreadCount).toBe(1);
    });
  });

  describe('R2-P2: text(isFinal) clears hasActiveInvocation', () => {
    it('non-final background stream marks thread as loading and active', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'still running',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.isLoading).toBe(true);
      expect(ts.hasActiveInvocation).toBe(true);
    });

    it('a later invocationless stream stays active after an identity-matched terminal slot', () => {
      const store = useChatStore.getState();
      store.setThreadCatInvocation('thread-bg', 'opus', {
        invocationId: 'inv-old',
        appServerLifecycle: {
          stage: 'closed',
          lastActivityAt: 123,
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        },
      });
      store.addThreadActiveInvocation('thread-bg', 'inv-old', 'opus', 'execute');

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'new invocationless stream',
        timestamp: Date.now(),
      });

      const state = useChatStore.getState();
      expect(state.getThreadState('thread-bg').activeInvocations).toEqual({});
      expect(selectThreadLiveness(state, 'thread-bg').hasActive).toBe(true);
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
        messageId: 'resp-1',
        origin: 'stream',
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
        messageId: 'post-1',
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
        messageId: 'post-callback-1',
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('post-callback-1');
      expect(ts.messages[0]?.origin).toBe('callback');
    });

    it('a post lands beside the open background response at once and later stream chunks still reach it', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        invocationId: 'inv-bg-post',
        messageId: 'resp-1',
        content: 'stream head',
        origin: 'stream',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        invocationId: 'inv-bg-post',
        content: 'authoritative callback',
        origin: 'callback',
        messageId: 'post-1',
        timestamp: now + 1,
      });

      // The post is its own message right away; the open response is untouched.
      expect(useChatStore.getState().getThreadState('thread-bg').messages).toEqual([
        expect.objectContaining({ id: 'resp-1', origin: 'stream', content: 'stream head', isStreaming: true }),
        expect.objectContaining({
          id: 'post-1',
          origin: 'callback',
          content: 'authoritative callback',
          isStreaming: false,
        }),
      ]);

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        invocationId: 'inv-bg-post',
        messageId: 'resp-1',
        content: ' + late tail',
        origin: 'stream',
        timestamp: now + 2,
      });

      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        invocationId: 'inv-bg-post',
        messageId: 'resp-1',
        isFinal: true,
        timestamp: now + 3,
      });

      // Z11: stream work-log stays separate from the post_message speech; nothing is suppressed.
      expect(useChatStore.getState().getThreadState('thread-bg').messages).toEqual([
        expect.objectContaining({
          id: 'resp-1',
          origin: 'stream',
          content: 'stream head + late tail',
          isStreaming: false,
        }),
        expect.objectContaining({
          id: 'post-1',
          origin: 'callback',
          content: 'authoritative callback',
          isStreaming: false,
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
        messageId: 'resp-opus',
        origin: 'stream',
        content: 'chunk 1',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        messageId: 'resp-codex',
        origin: 'stream',
        content: 'chunk 2',
        timestamp: now, // Same ms!
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      // Each cat's turn writes into its own response, even with the same timestamp
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0]).toMatchObject({ id: 'resp-opus', catId: 'opus', content: 'chunk 1' });
      expect(ts.messages[1]).toMatchObject({ id: 'resp-codex', catId: 'codex', content: 'chunk 2' });
    });
  });

  describe('F148: context briefing system_info — visible timeline projection', () => {
    it('projects a typed context_briefing card into the background thread timeline', () => {
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
              systemKind: 'context_briefing',
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
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]).toMatchObject({
        id: 'briefing-msg-1',
        type: 'system',
        origin: 'briefing',
        extra: {
          systemKind: 'context_briefing',
          rich: { blocks: [expect.objectContaining({ id: 'briefing-1', kind: 'card' })] },
        },
      });
    });

    it('ignores an incomplete briefing payload without a stored message id', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        content: JSON.stringify({
          type: 'context_briefing',
          messageId: 'briefing-msg-2',
          storedMessage: {
            content: 'briefing without id should not be swallowed',
            origin: 'briefing',
            timestamp: now,
          },
        }),
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(0);
    });
  });

  describe('regression: background stream chunk merging', () => {
    it('merges text chunks naming the same response into one assistant message', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '你',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '好',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('resp-1');
      expect(ts.messages[0].content).toBe('你好');
    });

    it('multi-chunk with final chunk closes streaming and keeps merged content', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '你',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '好',
        timestamp: now + 1,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '呀',
        isFinal: true,
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('resp-1');
      expect(ts.messages[0].content).toBe('你好呀');
      expect(ts.messages[0].isStreaming).toBe(false);
    });

    it('error naming the streaming response stops it without adding an error row', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'partial',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'error',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        error: 'oops',
        timestamp: now + 1,
      });

      // The response carries its own failure (lifecycle snapshot); no live error row duplicates it.
      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toEqual([expect.objectContaining({ id: 'resp-1', content: 'partial', isStreaming: false })]);
      expect(ts.messages.some((m) => m.type === 'system')).toBe(false);
      expect(ts.catStatuses.opus).toBe('error');
      expect(useToastStore.getState().toasts.map((toast) => toast.type)).toEqual(['error']);
    });
  });

  describe('regression: preserve non-text events in background path', () => {
    it('preserves tool_use as collapsed tool event on assistant message', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A', 'B'] },
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('resp-1');
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.content).toBe('');
      expect(ts.messages[0]?.toolEvents).toHaveLength(1);
      expect(ts.messages[0]?.toolEvents?.[0]?.type).toBe('tool_use');
      expect(ts.messages[0]?.toolEvents?.[0]?.label).toContain('opus → TodoWrite');
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('preserves the complete tool input behind the collapsed tool row', () => {
      const tail = 'TOOL_INPUT_TAIL_SENTINEL';
      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        toolName: 'Edit',
        toolInput: { file_path: 'src/example.ts', new_string: `${'x'.repeat(260)}${tail}` },
        timestamp: Date.now(),
      });

      const event = useChatStore.getState().getThreadState('thread-bg').messages[0]?.toolEvents?.[0];
      expect(event?.detail).toContain(tail);
      expect(JSON.parse(event?.detail ?? '{}')).toMatchObject({ file_path: 'src/example.ts' });
    });

    it('preserves tool_result as collapsed tool event on assistant message', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: 'line-1\nline-2',
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('resp-1');
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.content).toBe('');
      expect(ts.messages[0]?.toolEvents).toHaveLength(1);
      expect(ts.messages[0]?.toolEvents?.[0]?.type).toBe('tool_result');
      expect(ts.messages[0]?.toolEvents?.[0]?.label).toContain('opus ← result');
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('preserves the complete tool result behind the collapsed tool row', () => {
      const tail = 'TOOL_RESULT_TAIL_SENTINEL';
      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: `${'line\n'.repeat(80)}${tail}`,
        timestamp: Date.now(),
      });

      const event = useChatStore.getState().getThreadState('thread-bg').messages[0]?.toolEvents?.[0];
      expect(event?.detail).toContain(tail);
    });

    it('preserves recall-meta outside compacted visible tool_result detail', () => {
      const now = Date.now();
      const meta =
        '<recall-meta>{"resultStatus":"overflow","resultCount":12,"artifactRef":{"path":"/tmp/search.txt"}}</recall-meta>';
      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: [
          'Evidence search request failed: Error: result exceeds maximum allowed tokens.',
          'Full result saved to /tmp/search.txt',
          'preview line 1',
          'preview line 2',
          'preview line 3',
          meta,
        ].join('\n'),
        timestamp: now,
      });

      const event = useChatStore.getState().getThreadState('thread-bg').messages[0]?.toolEvents?.[0];
      expect(event?.detail).not.toContain('<recall-meta>');
      expect(event?.resultMeta).toBe(meta);
    });

    it('strips recall-meta from short visible tool_result detail', () => {
      const now = Date.now();
      const meta = '<recall-meta>{"resultStatus":"error","errorMessage":"graph failed"}</recall-meta>';
      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: ['Graph resolve failed: graph failed', meta].join('\n'),
        timestamp: now,
      });

      const event = useChatStore.getState().getThreadState('thread-bg').messages[0]?.toolEvents?.[0];
      expect(event?.detail).toBe('Graph resolve failed: graph failed');
      expect(event?.detail).not.toContain('<recall-meta>');
      expect(event?.resultMeta).toBe(meta);
    });

    it('tool_use + tool_result merge into one assistant message with two tool events', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A', 'B'] },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'tool_result',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: 'ok',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('resp-1');
      expect(ts.messages[0]?.type).toBe('assistant');
      expect(ts.messages[0]?.toolEvents).toHaveLength(2);
      expect(ts.messages[0]?.toolEvents?.[0]?.type).toBe('tool_use');
      expect(ts.messages[0]?.toolEvents?.[1]?.type).toBe('tool_result');
    });

    it('web_search system_info and later text land in the open response they name', () => {
      const now = Date.now();

      // The response was opened (lifecycle snapshot) while the thread was still active.
      seedProcessingResponse('thread-bg', 'resp-1', 'codex', '', now - 1);

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'codex',
        threadId: 'thread-bg',
        messageId: 'resp-1',
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
        messageId: 'resp-1',
        origin: 'stream',
        content: 'updated chunk',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      const assistantMessages = ts.messages.filter((m) => m.type === 'assistant' && m.catId === 'codex');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]?.id).toBe('resp-1');
      expect(assistantMessages[0]?.content).toBe('updated chunk');
      expect(assistantMessages[0]?.toolEvents).toHaveLength(1);
      expect(assistantMessages[0]?.toolEvents?.[0]?.label).toContain('web_search');
    });

    it('preserves system_info while ignoring retired a2a_handoff projections', () => {
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
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.content).toContain('system hint');
      expect(ts.messages[0]?.variant).toBe('info');
      expect(ts.messages.some((message) => message.content.includes('handoff info'))).toBe(false);
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
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0]?.variant).toBe('info');
      expect(ts.messages[0]?.extra?.systemInfo).toEqual({
        v: 1,
        payload: {
          type: 'mode_switch_proposal',
          proposedBy: '缅因猫',
          proposedMode: 'execute',
        },
        fallbackCatId: 'codex',
      });
      expect(ts.messages[1]?.variant).toBe('a2a_followup');
      expect(ts.messages[1]?.content).toContain('缅因猫 @了 opus');
      expect(ts.catInvocations.opus).toMatchObject({ sessionSeq: 3, sessionSealed: true });
    });

    it('does not create a background History notice from retired silent_completion metadata', () => {
      const resolveCatName = (catId: string) => (catId === 'codex' ? '缅因猫（sol）' : catId);

      simulateBackgroundMessage(
        {
          type: 'system_info',
          catId: 'codex',
          threadId: 'thread-bg',
          content: JSON.stringify({ type: 'silent_completion' }),
          timestamp: Date.now(),
        },
        resolveCatName,
      );

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toEqual([]);
    });

    it('consumes invocation_usage system_info into thread invocation + message metadata (no raw JSON message)', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'thinking',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 160123, outputTokens: 1589, cacheReadTokens: 114738, costUsd: 0.57 },
        }),
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('resp-1');
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

    it('keeps background Sol usage internal and writes the footer when cat telemetry projection throws', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex-sol',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'done',
        metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
        timestamp: now,
      });

      const telemetrySpy = vi.spyOn(useChatStore.getState(), 'setThreadCatInvocation').mockImplementationOnce(() => {
        throw new Error('simulated synchronous background cat telemetry projection failure');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        simulateBackgroundMessage({
          type: 'system_info',
          catId: 'codex-sol',
          threadId: 'thread-bg',
          messageId: 'resp-1',
          content: JSON.stringify({
            type: 'invocation_usage',
            catId: 'codex-sol',
            usage: { inputTokens: 126626, outputTokens: 2017, cacheReadTokens: 125696 },
            model: 'gpt-5.6-sol',
            provider: 'openai',
          }),
          timestamp: now + 1,
        });
        expect(warnSpy).toHaveBeenCalledWith(
          '[system_info] background internal projection failed; payload suppressed',
          expect.objectContaining({ catId: 'codex-sol', threadId: 'thread-bg' }),
        );
      } finally {
        telemetrySpy.mockRestore();
        warnSpy.mockRestore();
      }

      const messages = useChatStore.getState().getThreadState('thread-bg').messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.metadata).toMatchObject({
        model: 'gpt-5.6-sol',
        provider: 'openai',
        usage: { inputTokens: 126626, outputTokens: 2017, cacheReadTokens: 125696 },
      });
    });

    it('binds metadata+usage when tool event arrives before first text chunk', () => {
      const now = Date.now();

      simulateBackgroundMessage({
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A'] },
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'hello',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6', sessionId: 'sess-tool-first' },
        timestamp: now + 1,
      });

      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 321, outputTokens: 12, cacheReadTokens: 300 },
        }),
        timestamp: now + 2,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]?.id).toBe('resp-1');
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

      // New invocation's usage names its response before that response reached this client:
      // usage never creates it and never lands on another (historical) message.
      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
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

    // ─── F230 footer-parity regression tests ─────────────────────────────────────
    // PTY carrier: text events have no metadata (from transcriptEntriesToAgentMessages).
    // The only way to populate model/provider on PTY bubbles is via invocation_usage.
    // These tests pin the bg-path behavior.

    it('PTY-like: invocation_usage with model/provider sets metadata on bg message (F230 footer fix)', () => {
      const now = Date.now();
      // PTY carrier emits text without metadata
      simulateBackgroundMessage({
        type: 'text',
        catId: 'sonnet',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'Thinking...',
        // deliberately NO metadata — mimics PTY transcriptEntriesToAgentMessages output
        timestamp: now,
      });

      // invocation_usage arrives with model + provider
      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'sonnet',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'sonnet',
          usage: { inputTokens: 0, outputTokens: 1042, cacheReadTokens: 55932 },
          model: 'claude-sonnet-4-6',
          provider: 'claude_interactive_pty',
        }),
        timestamp: now + 10000,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      // F230 footer-parity: model and provider must be present on the bubble
      expect(ts.messages[0]?.metadata?.model).toBe('claude-sonnet-4-6');
      expect(ts.messages[0]?.metadata?.provider).toBe('claude_interactive_pty');
      // usage should also be present
      expect(ts.messages[0]?.metadata?.usage).toMatchObject({
        outputTokens: 1042,
        cacheReadTokens: 55932,
      });
    });

    it('F319 Phase E.1: served facts on invocation_usage land on the bg bubble live, merged into existing metadata', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex-sol',
        threadId: 'thread-bg',
        messageId: 'response-served-facts',
        content: 'OK',
        metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'codex-sol',
        threadId: 'thread-bg',
        messageId: 'response-served-facts',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'codex-sol',
          usage: { inputTokens: 10, outputTokens: 2 },
          model: 'gpt-5.6-sol',
          provider: 'openai',
          served: { servedModel: 'gpt-5.6-sol', servedModelSource: 'ws_response_object', upstreamTurnStateLength: 312 },
        }),
        timestamp: now + 1000,
      });
      const meta = useChatStore.getState().getThreadState('thread-bg').messages[0]?.metadata;
      expect(meta?.model).toBe('gpt-5.6-sol');
      expect(meta?.servedModel).toBe('gpt-5.6-sol');
      expect(meta?.servedModelSource).toBe('ws_response_object');
      expect(meta?.upstreamTurnStateLength).toBe(312);
      expect(meta?.usage).toMatchObject({ outputTokens: 2 });
    });

    it('bg-carrier regression: existing metadata model/provider not corrupted by invocation_usage (F230)', () => {
      const now = Date.now();
      // Normal bg carrier: text WITH metadata (model/provider already set)
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'hello',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now,
      });

      // invocation_usage with matching model/provider (same values = idempotent)
      simulateBackgroundMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 160000, outputTokens: 1589 },
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        }),
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      // Original metadata must survive intact (not corrupted by second write)
      expect(ts.messages[0]?.metadata?.provider).toBe('anthropic');
      expect(ts.messages[0]?.metadata?.model).toBe('claude-opus-4-6');
    });
    // ─── end F230 footer-parity regression tests ──────────────────────────────────

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

  describe('active→background transition: no bubble recovery', () => {
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
        messageId: 'resp-1',
        origin: 'stream',
        content: 'new invocation',
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0]).toMatchObject({ id: 'old-msg', content: 'old answer' });
      expect(ts.messages[1]).toMatchObject({ id: 'resp-1', content: 'new invocation' });
    });

    it('different cat streaming bubble is not recovered by wrong cat', () => {
      const now = Date.now();
      // Codex has an open (processing) response
      seedProcessingResponse('thread-bg', 'resp-codex', 'codex', 'codex thinking', now);

      // Opus names its own response and must not touch codex's
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-opus',
        origin: 'stream',
        content: 'opus thinking',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(2);
      expect(ts.messages[0].id).toBe('resp-codex');
      expect(ts.messages[0].content).toBe('codex thinking');
      expect(ts.messages[1]).toMatchObject({ id: 'resp-opus', catId: 'opus', content: 'opus thinking' });
    });
  });

  describe('stream chunks into the named response (update-storm regression)', () => {
    it('chunks merge content + metadata + streaming + catStatus into the named response', () => {
      const now = Date.now();
      // First chunk creates the response under its server id
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'first',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now,
      });

      // Second chunk appends into the existing response
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: ' second',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('resp-1');
      expect(ts.messages[0].content).toBe('first second');
      expect(ts.messages[0].isStreaming).toBe(true);
      expect(ts.messages[0].metadata?.provider).toBe('anthropic');
      expect(ts.catStatuses.opus).toBe('streaming');
    });

    it('high-frequency chunks append without state corruption', () => {
      const now = Date.now();
      // Simulate 50 rapid chunks (the kind that triggers React update depth)
      for (let i = 0; i < 50; i++) {
        simulateBackgroundMessage({
          type: 'text',
          catId: 'opus',
          threadId: 'thread-bg',
          messageId: 'resp-1',
          origin: 'stream',
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

    it('final chunk sets streaming=false and catStatus=done', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'start',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: ' end',
        isFinal: true,
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages[0].content).toBe('start end');
      expect(ts.messages[0].isStreaming).toBe(false);
      expect(ts.catStatuses.opus).toBe('done');
    });

    it('replace-mode chunk overwrites existing background stream content instead of appending', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '第一段。第二段。',
        timestamp: now,
      });

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: '第一段。插入一句。第二段。',
        textMode: 'replace',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].content).toBe('第一段。插入一句。第二段。');
    });
  });

  describe('F108: slot-aware background invocation tracking', () => {
    it('markThreadInvocationActive registers invocationId when available', () => {
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
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
        messageId: 'resp-opus',
        origin: 'stream',
        content: 'a',
        invocationId: 'inv-1',
        timestamp: Date.now(),
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-bg',
        messageId: 'resp-codex',
        origin: 'stream',
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
        messageId: 'resp-opus',
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
        messageId: 'resp-codex',
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

  describe('regression: background completion clears stale targetCats', () => {
    it('codex completion clears targetCats so subsequent opus start is clean', () => {
      const store = useChatStore.getState();
      // codex is running with a tracked invocation slot
      store.addThreadActiveInvocation('thread-bg', 'inv-codex-1', 'codex', 'execute');
      store.replaceThreadTargetCats('thread-bg', ['codex']);
      store.updateThreadCatStatus('thread-bg', 'codex', 'streaming');

      // codex finishes — done(isFinal) with invocationId
      simulateBackgroundMessage({
        type: 'done',
        catId: 'codex',
        threadId: 'thread-bg',
        invocationId: 'inv-codex-1',
        isFinal: true,
        timestamp: Date.now(),
      });

      // targetCats must be empty — no stale codex lingering
      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.targetCats).toEqual([]);
      expect(ts.catStatuses).toEqual({});

      // Now opus starts via queue auto-dequeue (uses setThreadTargetCats merge)
      store.setThreadTargetCats('thread-bg', ['opus']);
      const ts2 = useChatStore.getState().getThreadState('thread-bg');
      // Must be ['opus'] only, not ['codex', 'opus']
      expect(ts2.targetCats).toEqual(['opus']);
    });

    it('multi-cat: catA done does NOT clear targetCats while catB still active', () => {
      const store = useChatStore.getState();
      store.addThreadActiveInvocation('thread-bg', 'inv-opus-1', 'opus', 'execute');
      store.addThreadActiveInvocation('thread-bg', 'inv-codex-1', 'codex', 'execute');
      store.replaceThreadTargetCats('thread-bg', ['opus', 'codex']);

      // opus finishes — one slot remains
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        invocationId: 'inv-opus-1',
        isFinal: true,
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      // codex slot still active — targetCats must NOT be cleared
      expect(Object.keys(ts.activeInvocations)).toHaveLength(1);
      expect(ts.targetCats).toEqual(['opus', 'codex']);
    });

    it('last cat done clears targetCats in multi-cat scenario', () => {
      const store = useChatStore.getState();
      store.addThreadActiveInvocation('thread-bg', 'inv-opus-1', 'opus', 'execute');
      store.addThreadActiveInvocation('thread-bg', 'inv-codex-1', 'codex', 'execute');
      store.replaceThreadTargetCats('thread-bg', ['opus', 'codex']);

      // opus finishes first
      simulateBackgroundMessage({
        type: 'done',
        catId: 'opus',
        threadId: 'thread-bg',
        invocationId: 'inv-opus-1',
        isFinal: true,
        timestamp: Date.now(),
      });

      // codex finishes — last slot removed
      simulateBackgroundMessage({
        type: 'done',
        catId: 'codex',
        threadId: 'thread-bg',
        invocationId: 'inv-codex-1',
        isFinal: true,
        timestamp: Date.now(),
      });

      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.targetCats).toEqual([]);
      expect(ts.catStatuses).toEqual({});
    });

    it('legacy path without activeInvocations does not clear targetCats', () => {
      // Simulate legacy done where no activeInvocations were ever set
      useChatStore.getState().updateThreadCatStatus('thread-bg', 'opus', 'streaming');

      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'final',
        isFinal: true,
        timestamp: Date.now(),
      });

      // catStatus should still be 'done' — not wiped
      const ts = useChatStore.getState().getThreadState('thread-bg');
      expect(ts.catStatuses.opus).toBe('done');
    });
  });

  // F183 Phase B1.8 — bg text writes: a callback post arrives whole under its own id;
  // stream chunks write into the response they name, with or without invocationId.
  describe('B1.8: bg text writes into the message it names', () => {
    it('bg callback creates its own message under its server id', () => {
      const now = Date.now();
      // Empty thread — no response, no thread cat invocation
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-no-target',
        content: 'standalone callback',
        origin: 'callback',
        invocationId: 'inv-canon-2',
        messageId: 'post-1',
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg-no-target');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]).toMatchObject({
        id: 'post-1',
        type: 'assistant',
        catId: 'opus',
        content: 'standalone callback',
        origin: 'callback',
        isStreaming: false,
      });
      // Non-current bg thread: unread badge incremented
      expect(ts.unreadCount).toBe(1);
    });

    it('bg stream chunk creates the named response under its server id', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-new',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'first chunk',
        invocationId: 'inv-canon-3',
        timestamp: now,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg-stream-new');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0]).toMatchObject({
        id: 'resp-1',
        type: 'assistant',
        catId: 'opus',
        content: 'first chunk',
        isStreaming: true,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-canon-3' } },
      });
    });

    it('bg stream preserves typed child execution identity before the thread is opened', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-execution-kind',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'ordinary body with a guard-assisted route',
        invocationId: 'parent-execution',
        turnInvocationId: 'child-ordinary',
        extra: {
          turnExecution: {
            invocationId: 'child-ordinary',
            parentInvocationId: 'parent-execution',
            executionKind: 'ordinary',
          },
          auxiliaryTurnExecutions: [
            {
              invocationId: 'child-guard',
              parentInvocationId: 'parent-execution',
              executionKind: 'routing_guard',
            },
          ],
        },
        timestamp: now,
      });

      const [message] = useChatStore.getState().getThreadState('thread-bg-execution-kind').messages;
      expect(message.id).toBe('resp-1');
      expect(message.extra?.turnExecution).toEqual({
        invocationId: 'child-ordinary',
        parentInvocationId: 'parent-execution',
        executionKind: 'ordinary',
      });
      expect(message.extra?.auxiliaryTurnExecutions).toEqual([
        {
          invocationId: 'child-guard',
          parentInvocationId: 'parent-execution',
          executionKind: 'routing_guard',
        },
      ]);
    });

    it('bg stream chunk appends to the named response', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-append',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'first',
        invocationId: 'inv-canon-4',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-append',
        messageId: 'resp-1',
        origin: 'stream',
        content: ' second',
        invocationId: 'inv-canon-4',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg-stream-append');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('resp-1');
      expect(ts.messages[0].content).toBe('first second');
      expect(ts.messages[0].isStreaming).toBe(true);
    });

    it('bg stream chunk with textMode replace overwrites the named response content', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-replace',
        messageId: 'resp-1',
        origin: 'stream',
        content: '第一段。第二段。',
        invocationId: 'inv-canon-5',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-replace',
        messageId: 'resp-1',
        origin: 'stream',
        content: '第一段。插入。第二段。',
        invocationId: 'inv-canon-5',
        textMode: 'replace',
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg-stream-replace');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].content).toBe('第一段。插入。第二段。');
    });

    it('bg final stream chunk flips isStreaming=false on the named response', () => {
      const now = Date.now();
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-final',
        messageId: 'resp-1',
        origin: 'stream',
        content: 'start',
        invocationId: 'inv-canon-6',
        timestamp: now,
      });
      simulateBackgroundMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-bg-stream-final',
        messageId: 'resp-1',
        origin: 'stream',
        content: ' end',
        invocationId: 'inv-canon-6',
        isFinal: true,
        timestamp: now + 1,
      });

      const ts = useChatStore.getState().getThreadState('thread-bg-stream-final');
      expect(ts.messages[0].content).toBe('start end');
      expect(ts.messages[0].isStreaming).toBe(false);
      // Note: catStatuses 在 markThreadInvocationComplete -> replaceThreadTargetCats([])
      // 时被清空（slot 全部完成 → status panel 不再显示）。带 invocationId 的事件
      // 走 slot 追踪 (addThreadActiveInvocation)，所以 catStatuses 在 isFinal 后被清。
      // invocationless 不进 slot tracking，catStatuses 保留 'done'。两路都正确，
      // 不要在这里强 assert。
    });

    it('bg invocationless stream chunks still append into the named response (regression guard)', () => {
      const now = Date.now();
      // Note: NO invocationId — the messageId alone addresses the response
      for (let i = 0; i < 5; i++) {
        simulateBackgroundMessage({
          type: 'text',
          catId: 'opus',
          threadId: 'thread-bg-legacy',
          messageId: 'resp-1',
          origin: 'stream',
          content: `c${i}`,
          timestamp: now + i,
        });
      }

      const ts = useChatStore.getState().getThreadState('thread-bg-legacy');
      expect(ts.messages).toHaveLength(1);
      expect(ts.messages[0].id).toBe('resp-1');
      expect(ts.messages[0].content).toBe('c0c1c2c3c4');
      expect(ts.messages[0].isStreaming).toBe(true);
      expect(ts.catStatuses.opus).toBe('streaming');
    });
  });
});
