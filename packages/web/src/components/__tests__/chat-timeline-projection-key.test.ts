import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { buildChatTimelineProjectionKey } from '../chat-timeline-projection-key';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    type: 'assistant',
    catId: 'codex-sol',
    content: 'working',
    timestamp: 1,
    isStreaming: true,
    extra: {
      turnExecution: { invocationId: 'inv-1', parentInvocationId: 'parent-1', executionKind: 'ordinary' },
    },
    ...overrides,
  };
}

describe('buildChatTimelineProjectionKey', () => {
  it('ignores assistant stream content and tool deltas that cannot change cross-message projections', () => {
    const before = message();
    const after = message({
      content: 'working with another streamed token',
      toolEvents: [{ id: 'tool-1', type: 'tool_result', label: 'result', detail: 'large result', timestamp: 2 }],
    });

    expect(buildChatTimelineProjectionKey([after])).toBe(buildChatTimelineProjectionKey([before]));
  });

  it('changes when terminal or receipt topology changes', () => {
    const streaming = message();
    const terminal = message({ isStreaming: false });
    const receipt = message({
      type: 'user',
      catId: undefined,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-1',
          targets: [],
          reminderAttempts: [],
        },
      },
    });

    expect(buildChatTimelineProjectionKey([terminal])).not.toBe(buildChatTimelineProjectionKey([streaming]));
    expect(buildChatTimelineProjectionKey([receipt])).not.toBe(buildChatTimelineProjectionKey([streaming]));
  });
});
