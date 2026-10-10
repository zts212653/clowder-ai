/**
 * F045 P1 regression: a thinking-first response must receive metadata from subsequent text chunks.
 *
 * Sequence under test (foreground active thread), on the named-message write path:
 *   1. system_info(thinking, messageId R) → R exists without metadata (created empty by the
 *      server / its lifecycle snapshot or by this first body event) and gains thinking
 *   2. text(with metadata, messageId R) → appends content + merges metadata onto R
 *   3. system_info(invocation_usage, messageId R) → sets usage inside metadata
 *
 * Bug: Before the fix, step 2 only appended content, so the message never got
 * metadata, and step 3's usage write no-op'd (usage lands inside metadata).
 *
 * Uses real useChatStore (no mocks) to verify store state transitions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenUsage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const THREAD_ID = 'thread-active';
const CAT_ID = 'opus';
const MSG_ID = 'resp-1';

function findResponse() {
  const message = useChatStore.getState().messages.find((m) => m.id === MSG_ID);
  if (!message) throw new Error(`expected message ${MSG_ID}`);
  return message;
}

describe('F045: thinking-first placeholder metadata flow', () => {
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
      currentThreadId: THREAD_ID,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  it('RED→GREEN: metadata and usage survive the thinking→text→usage sequence', () => {
    const store = useChatStore.getState();

    // Step 1: the response exists without metadata (worst case) and receives thinking
    store.addMessageToThread(THREAD_ID, {
      id: MSG_ID,
      type: 'assistant',
      catId: CAT_ID,
      content: '',
      origin: 'stream',
      timestamp: Date.now(),
      isStreaming: true,
    });
    store.setThreadMessageThinking(THREAD_ID, MSG_ID, 'I am planning my response...');

    // Verify: the response has thinking but no metadata
    const afterThinking = findResponse();
    expect(afterThinking.thinking).toBe('I am planning my response...');
    expect(afterThinking.metadata).toBeUndefined();

    // Step 2: text chunk arrives with metadata → merge onto the response
    const metadata = { provider: 'anthropic', model: 'claude-opus-4-5-20250514' };
    store.appendToThreadMessage(THREAD_ID, MSG_ID, 'Hello, I am responding.');
    store.setThreadMessageMetadata(THREAD_ID, MSG_ID, metadata);

    // Verify: metadata is now present
    const afterText = findResponse();
    expect(afterText.content).toBe('Hello, I am responding.');
    expect(afterText.metadata).toBeDefined();
    expect(afterText.metadata?.provider).toBe('anthropic');

    // Step 3: invocation_usage arrives → the usage write should succeed (not no-op)
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    store.setThreadMessageUsage(THREAD_ID, MSG_ID, usage);

    // Verify: usage is set inside metadata
    const afterUsage = findResponse();
    expect(afterUsage.metadata).toBeDefined();
    expect(afterUsage.metadata?.usage).toEqual(usage);
  });

  it('setMessageMetadata skips when metadata already exists (streaming perf guard)', () => {
    const store = useChatStore.getState();

    store.addMessage({
      id: MSG_ID,
      type: 'assistant',
      catId: CAT_ID,
      content: 'hi',
      origin: 'stream',
      metadata: { provider: 'anthropic', model: 'claude-opus-4-5-20250514' },
      timestamp: Date.now(),
    });

    // Second call should be a no-op (guard prevents per-chunk re-render)
    store.setMessageMetadata(MSG_ID, { provider: 'openai', model: 'gpt-4' });

    const msg = findResponse();
    // Original metadata preserved, not overwritten
    expect(msg.metadata?.provider).toBe('anthropic');
    expect(msg.metadata?.model).toBe('claude-opus-4-5-20250514');
  });

  it('setMessageMetadata is idempotent (same metadata applied twice produces same state)', () => {
    const store = useChatStore.getState();
    const metadata = { provider: 'anthropic', model: 'claude-opus-4-5-20250514' };

    store.addMessage({
      id: MSG_ID,
      type: 'assistant',
      catId: CAT_ID,
      content: '',
      origin: 'stream',
      timestamp: Date.now(),
    });

    store.setMessageMetadata(MSG_ID, metadata);
    const after1 = findResponse();

    store.setMessageMetadata(MSG_ID, metadata);
    const after2 = findResponse();

    expect(after1.metadata).toEqual(after2.metadata);
  });
});
