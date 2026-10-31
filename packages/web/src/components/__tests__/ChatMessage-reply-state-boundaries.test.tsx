import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

describe('F322 reply presentation state boundaries', () => {
  let harness: ReplyLayersHarness;

  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    harness = new ReplyLayersHarness();
    harness.enableV2();
  });
  afterEach(() => harness.dispose());

  it.each([
    'succeeded',
    'canceled',
    'failed',
  ] as const)('exposes terminal recall for %s despite a stale streaming flag', (phase) => {
    const reply = replyWithReconciliation(phase, true);
    harness.renderTimeline([reply], recallFor(reply));

    expect(harness.q('reply-recall')?.textContent).toBe('召回 1');
    harness.click('reply-record-toggle');
    expect(harness.q('reply-record-recall')?.textContent).toBe('检索 1');
  });

  it('an interrupted response has terminal recall and a stopped status', () => {
    const reply = replyWithReconciliation('unknown_running', false);
    harness.renderTimeline([reply], recallFor(reply));

    expect(harness.q('reply-status')?.textContent).toBe('已停止');
    expect(harness.q('reply-recall')?.textContent).toBe('召回 1');
  });
});

function replyWithReconciliation(
  phase: 'succeeded' | 'canceled' | 'failed' | 'unknown_running',
  isStreaming: boolean,
): ChatMessage {
  return streamReply({
    isStreaming,
    lifecycle: {
      kind: 'response',
      orderKey: '1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: phase === 'succeeded' ? 'completed' : phase === 'unknown_running' ? 'interrupted' : phase,
      startedAt: 1,
    },
    extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
  });
}

function recallFor(reply: ChatMessage) {
  return new Map([
    [
      reply.id,
      {
        invocationId: 'turn-1',
        catId: 'opus',
        status: 'ready' as const,
        events: [{ id: 'search', query: 'F322', timestamp: 1, toolName: 'search_evidence' }],
      },
    ],
  ]);
}
