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

  it('changes when terminal or delivery topology changes', () => {
    const streaming = message();
    const terminal = message({ isStreaming: false });
    const delivered = message({
      type: 'user',
      catId: undefined,
      lifecycle: {
        version: 1,
        dispatchRefs: [
          {
            targetId: 'codex-sol',
            invocationId: 'inv-delivered',
            statusMessageId: 'response-1',
            dispatchedAt: 2,
            phase: 'dispatched',
          },
        ],
      },
    });

    expect(buildChatTimelineProjectionKey([terminal])).not.toBe(buildChatTimelineProjectionKey([streaming]));
    expect(buildChatTimelineProjectionKey([delivered])).not.toBe(buildChatTimelineProjectionKey([streaming]));
  });
});
