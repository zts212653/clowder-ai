import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { type BackgroundAgentMessage, consumeBackgroundSystemInfo } from '../useAgentMessages';

function consume(content: string) {
  const store = useChatStore.getState();
  const msg: BackgroundAgentMessage = {
    type: 'system_info',
    catId: 'codex-sol',
    threadId: 'thread-background',
    content,
    timestamp: Date.now(),
  };
  return consumeBackgroundSystemInfo(msg, undefined, {
    store,
    bgStreamRefs: new Map(),
    finalizedBgRefs: new Map(),
    nextBgSeq: () => 1,
    addToast: vi.fn(),
  });
}

describe('background system_info protocol fallback', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-active',
      threadStates: {},
      catInvocations: {},
      catStatuses: {},
    });
  });

  it.each([
    { type: 'context_presentation_receipt', v: 1, invocationId: 'inv-receipt' },
    { type: 'context_continuity', v: 1, invocationId: 'inv-continuity' },
    { type: 'future_internal_protocol_event', v: 1 },
  ])('fails closed for unprojected structured protocol $type', (payload) => {
    expect(consume(JSON.stringify(payload)).consumed).toBe(true);
  });

  it('fails closed when a recognized internal projector throws', () => {
    const store = useChatStore.getState();
    const projectionSpy = vi.spyOn(store, 'setThreadCatInvocation').mockImplementation(() => {
      throw new Error('simulated background context-health projection failure');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(
        consume(
          JSON.stringify({
            type: 'context_health',
            health: { usedTokens: 42, windowTokens: 200000 },
          }),
        ).consumed,
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      projectionSpy.mockRestore();
    }
  });

  it('leaves plain-text notices on the user-visible fallback path', () => {
    expect(consume('服务连接已恢复')).toEqual(expect.objectContaining({ consumed: false, content: '服务连接已恢复' }));
  });
});
