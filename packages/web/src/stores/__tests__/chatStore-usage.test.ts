/**
 * F8: Token usage integration tests
 * Verifies that setCatInvocation correctly stores and merges TokenUsage data,
 * simulating what useAgentMessages does when receiving invocation_usage events.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

describe('F8: chatStore token usage', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
    useChatStore.getState().clearCatStatuses();
  });

  it('F319 Phase E.1: mergeMessageServedFacts merges onto metadata that setMessageMetadata already wrote', () => {
    const store = useChatStore.getState();
    store.addMessage({
      id: 'msg-sol',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'OK',
      timestamp: 1,
      metadata: { provider: 'openai', model: 'gpt-5.6-sol', usage: { inputTokens: 10 } },
    });
    store.setMessageMetadata('msg-sol', { provider: 'x', model: 'y' }); // first-write-wins: ignored
    store.mergeMessageServedFacts('msg-sol', { servedModel: 'gpt-5.6-sol', upstreamTurnStateLength: 312 });
    const meta = useChatStore.getState().messages.find((m) => m.id === 'msg-sol')?.metadata;
    expect(meta).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      usage: { inputTokens: 10 },
      servedModel: 'gpt-5.6-sol',
      upstreamTurnStateLength: 312,
    });
  });

  it('F319 Phase E.1: mergeMessageServedFacts is a no-op on a message without metadata (never invents model/provider)', () => {
    const store = useChatStore.getState();
    store.addMessage({ id: 'msg-bare', type: 'assistant', catId: 'codex-sol', content: 'OK', timestamp: 1 });
    store.mergeMessageServedFacts('msg-bare', { servedModel: 'gpt-5.6-sol' });
    expect(useChatStore.getState().messages.find((m) => m.id === 'msg-bare')?.metadata).toBeUndefined();
  });

  it('setCatInvocation stores usage data for a cat', () => {
    const store = useChatStore.getState();
    store.setCatInvocation('opus', {
      usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.03 },
    });

    const info = useChatStore.getState().catInvocations.opus;
    expect(info).toBeDefined();
    expect(info?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.03,
    });
  });

  it('setCatInvocation merges usage with existing invocation info', () => {
    const store = useChatStore.getState();

    // First: session_started metrics
    store.setCatInvocation('opus', {
      sessionId: 'sess-1',
      invocationId: 'inv-1',
      startedAt: 1000,
    });

    // Second: invocation_complete metrics
    store.setCatInvocation('opus', {
      durationMs: 4500,
    });

    // Third: invocation_usage
    store.setCatInvocation('opus', {
      usage: { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 1500 },
    });

    const info = useChatStore.getState().catInvocations.opus;
    expect(info).toBeDefined();
    expect(info?.sessionId).toBe('sess-1');
    expect(info?.invocationId).toBe('inv-1');
    expect(info?.startedAt).toBe(1000);
    expect(info?.durationMs).toBe(4500);
    expect(info?.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 1500,
    });
  });

  it('setMessageUsage persists usage on a specific message metadata', () => {
    const store = useChatStore.getState();
    store.addMessage({
      id: 'msg-1',
      type: 'assistant',
      catId: 'opus',
      content: 'hello',
      timestamp: 1000,
      metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
    });
    store.addMessage({
      id: 'msg-2',
      type: 'assistant',
      catId: 'opus',
      content: 'world',
      timestamp: 2000,
      metadata: { provider: 'anthropic', model: 'claude-opus-4-6' },
    });

    // Set usage on msg-1 only
    store.setMessageUsage('msg-1', { inputTokens: 1000, outputTokens: 500 });

    const msgs = useChatStore.getState().messages;
    expect(msgs[0].metadata?.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    // msg-2 should NOT have usage
    expect(msgs[1].metadata?.usage).toBeUndefined();
  });

  it('stores usage for multiple cats independently', () => {
    const store = useChatStore.getState();

    store.setCatInvocation('opus', {
      usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.03 },
    });
    store.setCatInvocation('codex', {
      usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 50 },
    });
    store.setCatInvocation('gemini', {
      usage: { totalTokens: 150 },
    });

    const state = useChatStore.getState();
    expect(state.catInvocations.opus?.usage?.costUsd).toBe(0.03);
    expect(state.catInvocations.codex?.usage?.inputTokens).toBe(200);
    expect(state.catInvocations.gemini?.usage?.totalTokens).toBe(150);
  });
});
