/**
 * F194 live A2A post_message swallow — REAL-STORE incident regression net.
 *
 * Origin: 2026-06-10 incident (co-creator report, thread_mq80o1cd4xj479pa) — live
 * bubbles split/swallowed while F5 showed the truth. Deterministic repro in
 * thread_mq81iu28rgplrd3q: 3 persisted messages, only 1 visible live (defer-Map
 * overwrite + stable-key replacement chain). These tests were extracted from
 * that incident; the fix itself landed via clowder-ai#834 intake (0727e30a5,
 * isExplicitPost mechanism — explicit posts are invocationless and exempt from
 * every stable-key merge path). This file pins the incident's behavior surface
 * against the REAL chatStore (no mock — a mocked addMessage hid the TD112
 * hard-merge in an earlier fix attempt, gpt52 R1 catch):
 *
 *   1. Two explicit posts under one turn stay separate messages; same-id
 *      replay adds nothing. Nothing merges a post into the response.
 *   2. Queued delivery (persisted isExplicitPost shape vs live stream bubble)
 *      stays standalone — markMessagesDelivered routes through this dedup.
 *   3. Background thread: explicit posts land immediately beside the response
 *      R while it streams, and later work-log chunks still land in R.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configureDebug } from '@/debug/invocationEventDebug';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage } from '../useAgentMessages';

let testBgSeq = 0;

function dispatchBg(msg: BackgroundAgentMessage) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    nextBgSeq: () => testBgSeq++,
    addToast: () => {},
  });
}

const BG_THREAD = 'thread-bg';
const PARENT_INV = 'parent-chain-inv-9';
const TURN_INV = 'turn-inv-9';
const RESPONSE_ID = 'resp-turn-inv-9';

describe('F194 speech vs real store dedup (no mock — gpt52 R1)', () => {
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
      activeInvocations: {},
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

  describe('TD112 dedup guard (chatStore.addMessage, real semantics)', () => {
    it('two different-server-id explicit posts under the same turn key stay separate', () => {
      // Real contract (#834/#814): every post_message record carries
      // extra.isExplicitPost at persist time. (Two UNMARKED different-id
      // callbacks under one turn key would still hard-merge — theoretical
      // residue only, no production writer emits that shape; noted as P3.)
      const store = useChatStore.getState();
      store.addMessage({
        id: 'srv-speech-1',
        type: 'assistant',
        catId: 'sonnet',
        content: '探针A',
        origin: 'callback',
        isStreaming: false,
        extra: { isExplicitPost: true, stream: { invocationId: PARENT_INV, turnInvocationId: TURN_INV } },
        timestamp: 1000,
      });
      useChatStore.getState().addMessage({
        id: 'srv-speech-2',
        type: 'assistant',
        catId: 'sonnet',
        content: '探针B',
        origin: 'callback',
        isStreaming: false,
        extra: { isExplicitPost: true, stream: { invocationId: PARENT_INV, turnInvocationId: TURN_INV } },
        timestamp: 2000,
      });

      const msgs = useChatStore.getState().messages;
      // RED before guard: TD112 Phase 1 hard rule merges 探针B into 探针A.
      expect(msgs.map((m) => m.id)).toEqual(expect.arrayContaining(['srv-speech-1', 'srv-speech-2']));
      expect(msgs.find((m) => m.id === 'srv-speech-1')?.content).toBe('探针A');
      expect(msgs.find((m) => m.id === 'srv-speech-2')?.content).toBe('探针B');
    });

    it('same-id replay still dedupes (idempotency preserved)', () => {
      const mk = () => ({
        id: 'srv-speech-1',
        type: 'assistant' as const,
        catId: 'sonnet',
        content: '探针A',
        origin: 'callback' as const,
        isStreaming: false,
        extra: { stream: { invocationId: PARENT_INV, turnInvocationId: TURN_INV } },
        timestamp: 1000,
      });
      useChatStore.getState().addMessage(mk());
      useChatStore.getState().addMessage(mk());
      expect(useChatStore.getState().messages.filter((m) => m.id === 'srv-speech-1')).toHaveLength(1);
    });

    it('queued explicit post via markMessagesDelivered vs existing STREAM bubble stays separate (gpt52 R2 P1-1 / R3 tightening)', () => {
      // gpt52 R3 (non-blocking, applied immediately — no follow-up tails): hit
      // the REAL queued writer (markMessagesDelivered insert branch, which
      // routes through findAssistantDuplicate) instead of bare addMessage.
      // The payload mirrors QueueProcessor's deliveredMessages shape: the
      // persisted record carries extra.isExplicitPost stamped at persist time.
      useChatStore.getState().addMessage({
        id: `msg-${TURN_INV}-sonnet`,
        type: 'assistant',
        catId: 'sonnet',
        content: '流式工作日志',
        origin: 'stream',
        isStreaming: true,
        extra: { stream: { invocationId: PARENT_INV, turnInvocationId: TURN_INV } },
        timestamp: 1000,
      });
      useChatStore.getState().markMessagesDelivered('thread-active', ['srv-queued-speech'], 2100, [
        {
          id: 'srv-queued-speech',
          content: '排队探针',
          catId: 'sonnet',
          timestamp: 2000,
          origin: 'callback',
          extra: { isExplicitPost: true, stream: { invocationId: PARENT_INV, turnInvocationId: TURN_INV } },
        },
      ]);

      const msgs = useChatStore.getState().messages;
      // RED before incoming-side guard: the insert branch's findAssistantDuplicate
      // merged the queued explicit post INTO the same-turn stream bubble.
      expect(msgs.map((m) => m.id)).toEqual(expect.arrayContaining([`msg-${TURN_INV}-sonnet`, 'srv-queued-speech']));
      expect(msgs.find((m) => m.id === `msg-${TURN_INV}-sonnet`)?.content).toBe('流式工作日志');
      expect(msgs.find((m) => m.id === 'srv-queued-speech')?.content).toBe('排队探针');
    });
  });

  describe('background thread speech (gpt52 R1 P1-2)', () => {
    function bgStreamPrelude() {
      // The turn's work log streams into its response R, named by every stream event.
      dispatchBg({
        type: 'text',
        catId: 'sonnet',
        content: '后台流式工作日志',
        messageId: RESPONSE_ID,
        invocationId: PARENT_INV,
        turnInvocationId: TURN_INV,
        origin: 'stream',
        threadId: BG_THREAD,
        timestamp: 1000,
      });
    }

    function bgSpeech(content: string, messageId: string, timestamp: number) {
      dispatchBg({
        type: 'text',
        catId: 'sonnet',
        content,
        messageId,
        invocationId: PARENT_INV,
        turnInvocationId: TURN_INV,
        origin: 'callback',
        extra: { isExplicitPost: true },
        threadId: BG_THREAD,
        timestamp,
      });
    }

    function bgRows() {
      return useChatStore
        .getState()
        .getThreadState(BG_THREAD)
        .messages.filter((m) => m.type === 'assistant' && m.catId === 'sonnet');
    }

    it('speech lands immediately as standalone records while bg stream is open (no defer, no overwrite)', () => {
      bgStreamPrelude();
      bgSpeech('后台探针A', 'srv-bg-A', 2000);
      bgSpeech('后台探针B', 'srv-bg-B', 3000);

      const contents = bgRows().map((m) => m.content);
      expect(contents).toContain('后台探针A');
      expect(contents).toContain('后台探针B');
      // The response R survives beside the posts and is still streaming.
      const response = bgRows().find((m) => m.id === RESPONSE_ID);
      expect(response?.content).toBe('后台流式工作日志');
      expect(response?.isStreaming).toBe(true);
    });

    it('stream chunks AFTER speech still land in the work-log bubble (gpt52 R2 P1-2)', () => {
      bgStreamPrelude();
      bgSpeech('后台探针A', 'srv-bg-A', 2000);
      dispatchBg({
        type: 'text',
        catId: 'sonnet',
        content: '后续工作日志尾巴',
        messageId: RESPONSE_ID,
        invocationId: PARENT_INV,
        turnInvocationId: TURN_INV,
        origin: 'stream',
        threadId: BG_THREAD,
        timestamp: 3000,
      });
      const response = bgRows().find((m) => m.id === RESPONSE_ID);
      expect(response?.content).toBe('后台流式工作日志后续工作日志尾巴');
      expect(bgRows().find((m) => m.id === 'srv-bg-A')?.content).toBe('后台探针A');
    });

    it('bg speech replay by same messageId is idempotent', () => {
      bgStreamPrelude();
      bgSpeech('后台探针A', 'srv-bg-A', 2000);
      bgSpeech('后台探针A', 'srv-bg-A', 2100);
      expect(bgRows().filter((m) => m.id === 'srv-bg-A')).toHaveLength(1);
    });
  });
});
