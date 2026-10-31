import { describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  installBackgroundHarness,
  seedProcessingResponse,
  threadCodexStreamBubbles,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

const BG = 'thread-bg';
const RESPONSE = 'resp-bg-1';

function bgTool(parent: string, ts = 1000) {
  return {
    type: 'tool_use' as const,
    catId: 'codex' as const,
    threadId: BG,
    messageId: RESPONSE,
    toolName: 'shell',
    toolInput: { command: 'rg --files' },
    invocationId: parent,
    timestamp: ts,
  };
}

describe('Codex background path — tool work-log lands in the named response', () => {
  const bg = installBackgroundHarness();

  it('attaches a suppressed child event to the background root response without a child system bubble', () => {
    const parent = 'parent-subexecution-background';
    const childEvent = {
      v: 1 as const,
      id: 'subexecution:child-background:message',
      kind: 'subexecution' as const,
      occurredAt: 1010,
      stage: 'message' as const,
      subexecutionId: 'child-background',
      rootExecutionId: 'root-provider-thread',
      parentExecutionId: 'root-provider-thread',
      rootTurnId: 'root-provider-turn',
      parentTurnId: 'root-provider-turn',
      turnId: 'child-provider-turn',
      agentPath: '/root/review_delta',
      nickname: 'Bohr',
      depth: 1,
      content: 'Approve from background child',
      messagePhase: 'final_answer' as const,
    };

    // Child-execution metadata describes the response; it never creates it, so R is present
    // as its lifecycle snapshot publishes it at dispatch.
    seedProcessingResponse(BG, RESPONSE, 'codex', parent);
    bg.dispatchBg({
      type: 'system_info',
      catId: 'codex',
      threadId: BG,
      messageId: RESPONSE,
      invocationId: parent,
      timestamp: 1010,
      semanticEvent: childEvent,
      metadata: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        subexecutionEvents: [childEvent],
      },
    });

    const messages = useChatStore.getState().getThreadState(BG).messages;
    expect(messages.find((message) => message.id === RESPONSE)?.metadata?.subexecutionEvents).toEqual([childEvent]);
    expect(messages.some((message) => message.content.includes('Approve from background child'))).toBe(false);
  });

  it('keeps a background file_change tool card when its semantic diff augments the native carrier', () => {
    bg.dispatchBg({
      ...bgTool('parent-bg-file-change'),
      toolName: 'file_change',
      toolInput: { status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update' }] },
      semanticEvent: {
        v: 1,
        id: 'diff-background-1',
        kind: 'diff',
        occurredAt: 1000,
        stage: 'completed',
        summary: '1 个文件变更',
      },
    });

    const streamBubbles = threadCodexStreamBubbles(BG);
    expect(streamBubbles.map((message) => message.id)).toEqual([RESPONSE]);
    expect(streamBubbles[0]?.toolEvents?.some((event) => event.label.includes('file_change'))).toBe(true);
    expect(
      useChatStore
        .getState()
        .getThreadState(BG)
        .messages.some((message) => message.id === 'semantic:diff-background-1'),
    ).toBe(false);
  });
});
