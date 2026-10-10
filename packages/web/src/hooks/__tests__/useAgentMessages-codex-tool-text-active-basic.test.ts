import { describe, expect, it, vi } from 'vitest';
import { selectThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import {
  flatCodexStreamBubbles,
  installActiveHarness,
  seedProcessingResponse,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

const THREAD = 'thread-1';
const RESPONSE = 'resp-1';

function tool(parent: string, ts: number, turn?: string) {
  return {
    type: 'tool_use' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    messageId: RESPONSE,
    toolName: 'shell',
    toolInput: { command: 'rg --files' },
    invocationId: parent,
    ...(turn ? { turnInvocationId: turn } : {}),
    timestamp: ts,
  };
}

function text(parent: string, content: string, ts: number, turn?: string) {
  return {
    type: 'text' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    messageId: RESPONSE,
    content,
    origin: 'stream' as const,
    invocationId: parent,
    ...(turn ? { turnInvocationId: turn } : {}),
    timestamp: ts,
  };
}

describe('Codex active path — tool work-log + text land in the named response', () => {
  const harness = installActiveHarness();

  it('attaches a suppressed child event to the root response without mixing child prose into root text', () => {
    const parent = 'parent-subexecution-active';
    const turn = 'turn-subexecution-active';
    const childEvent = {
      v: 1 as const,
      id: 'subexecution:child-active:message',
      kind: 'subexecution' as const,
      occurredAt: 1010,
      stage: 'message' as const,
      subexecutionId: 'child-active',
      rootExecutionId: 'root-provider-thread',
      parentExecutionId: 'root-provider-thread',
      rootTurnId: 'root-provider-turn',
      parentTurnId: 'root-provider-turn',
      turnId: 'child-provider-turn',
      agentPath: '/root/review_delta',
      nickname: 'Bohr',
      depth: 1,
      content: 'Approve from child',
      messagePhase: 'final_answer' as const,
    };

    // Child-execution metadata describes the response; it never creates it, so R is present
    // as its lifecycle snapshot publishes it at dispatch.
    seedProcessingResponse(THREAD, RESPONSE, 'codex', turn);
    harness.render();
    harness.send({
      type: 'system_info',
      catId: 'codex',
      threadId: THREAD,
      messageId: RESPONSE,
      invocationId: parent,
      turnInvocationId: turn,
      timestamp: 1010,
      semanticEvent: childEvent,
      metadata: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        subexecutionEvents: [childEvent],
      },
    });
    harness.send(text(parent, 'root final survives', 1020, turn));

    const rootResponse = useChatStore.getState().messages.find((message) => message.id === RESPONSE);
    expect(rootResponse?.content).toBe('root final survives');
    expect(rootResponse?.metadata?.subexecutionEvents).toEqual([childEvent]);
    expect(useChatStore.getState().messages.some((message) => message.content.includes('Approve from child'))).toBe(
      false,
    );
  });

  it('keeps a file_change tool card when its semantic diff augments the native carrier', () => {
    const parent = 'parent-file-change';
    const turn = 'turn-file-change';
    harness.render();
    harness.send({
      ...tool(parent, 1000, turn),
      toolName: 'file_change',
      toolInput: { status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update' }] },
      semanticEvent: {
        v: 1,
        id: 'diff-active-1',
        kind: 'diff',
        occurredAt: 1000,
        stage: 'completed',
        summary: '1 个文件变更',
      },
    });

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles.map((message) => message.id)).toEqual([RESPONSE]);
    expect(streamBubbles[0]?.toolEvents?.some((event) => event.label.includes('file_change'))).toBe(true);
    expect(useChatStore.getState().messages.some((message) => message.id === 'semantic:diff-active-1')).toBe(false);
  });

  it('moves a processing response behind later messages when a tool event proves new activity', () => {
    const parent = 'parent-live-order';
    const turn = 'turn-live-order';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      harness.render();
      harness.send(tool(parent, 1_000, turn));
      expect(flatCodexStreamBubbles().map((message) => message.id)).toEqual([RESPONSE]);

      useChatStore.getState().addMessage({
        id: 'user-after-first-tool',
        type: 'user',
        content: 'new context',
        timestamp: 2_000,
      });
      expect(selectThreadMessages(useChatStore.getState(), THREAD).at(-1)?.id).toBe('user-after-first-tool');

      vi.setSystemTime(3_000);
      harness.send(tool(parent, 3_000, turn));

      expect(selectThreadMessages(useChatStore.getState(), THREAD).at(-1)).toMatchObject({
        id: RESPONSE,
        timestamp: 3_000,
        timelineOrderAt: 3_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
