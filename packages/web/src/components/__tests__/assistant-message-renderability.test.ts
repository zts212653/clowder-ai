import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  doesAssistantMessageRenderBubble,
  projectEmptyResponseLifecycleNotice,
} from '../assistant-message-renderability';

function response(
  status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted',
  content = '',
): ChatMessage {
  return {
    id: 'response-1',
    type: 'assistant',
    catId: 'opus',
    content,
    timestamp: 100,
    isStreaming: status === 'processing',
    extra: {
      turnExecution: {
        invocationId: 'turn-1',
        parentInvocationId: 'parent-1',
        executionKind: 'ordinary',
      },
    },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn-1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['source-1'],
      status,
      startedAt: 100,
      ...(status === 'processing' ? {} : { completedAt: 120 }),
    },
  };
}

describe('doesAssistantMessageRenderBubble', () => {
  it('keeps the processing response on the execution tip until the first stream chunk', () => {
    expect(doesAssistantMessageRenderBubble(response('processing'))).toBe(false);
    expect(projectEmptyResponseLifecycleNotice(response('processing'))).toEqual({
      label: '正在回复…',
      tone: 'processing',
    });
  });

  it('allows a processing response only after real partial content exists', () => {
    expect(doesAssistantMessageRenderBubble(response('processing', 'partial'))).toBe(true);
  });

  it.each(['completed', 'failed'] as const)('keeps one terminal %s response bubble even without body', (status) => {
    expect(doesAssistantMessageRenderBubble(response(status))).toBe(true);
  });

  it.each([
    ['canceled', '已停止回复。', 'canceled'],
    ['interrupted', '回复已中断。', 'canceled'],
    ['failed', '回复失败。', 'failed'],
    ['completed', '已完成，没有返回可显示内容。', 'completed'],
  ] as const)('gives an empty %s response an explicit terminal message', (status, label, tone) => {
    expect(projectEmptyResponseLifecycleNotice(response(status))).toEqual({ label, tone });
  });

  it('does not add a lifecycle notice once real content owns the bubble', () => {
    expect(projectEmptyResponseLifecycleNotice(response('processing', 'partial'))).toBeNull();
  });
});
