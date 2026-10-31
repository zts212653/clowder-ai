import { describe, expect, it } from 'vitest';
import {
  flatCodexStreamBubbles,
  installActiveHarness,
  installBackgroundHarness,
  seedProcessingResponse,
  threadCodexStreamBubbles,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

const event = (type: 'tool_use' | 'tool_result', threadId: string) => ({
  type,
  catId: 'codex',
  threadId,
  messageId: threadId === 'thread-1' ? 'response-active' : 'response-background',
  invocationId: 'parent',
  turnInvocationId: 'child',
  timestamp: 1,
  toolName: 'Read',
  toolUseId: 'native-pair',
  content: type === 'tool_result' ? 'done' : undefined,
  toolEventId: type === 'tool_use' ? 'tool-api-use' : 'toolr-api-result',
  toolExecutionRef: 'child',
});

describe('API event instance identity in real active tool handling', () => {
  const active = installActiveHarness();
  it('retains API IDs and child refs, rather than generating UI-only identities', () => {
    seedProcessingResponse('thread-1', 'response-active', 'codex', 'child');
    active.render();
    active.send(event('tool_use', 'thread-1'));
    active.send(event('tool_result', 'thread-1'));
    const tools = flatCodexStreamBubbles().flatMap((message) => message.toolEvents ?? []);
    expect(tools.map((tool) => tool.toolUseId)).toEqual(['native-pair', 'native-pair']);
    expect(tools.map((tool) => [tool.id, tool.executionRef])).toEqual([
      ['tool-api-use', 'child'],
      ['toolr-api-result', 'child'],
    ]);
  });
});

describe('API event instance identity in real background tool handling', () => {
  const background = installBackgroundHarness();
  it('retains the same IDs/ref and native pair key across thread switching', () => {
    seedProcessingResponse('thread-bg', 'response-background', 'codex', 'child');
    background.dispatchBg(event('tool_use', 'thread-bg'));
    background.dispatchBg(event('tool_result', 'thread-bg'));
    const tools = threadCodexStreamBubbles('thread-bg').flatMap((message) => message.toolEvents ?? []);
    expect(tools.map((tool) => [tool.id, tool.executionRef])).toEqual([
      ['tool-api-use', 'child'],
      ['toolr-api-result', 'child'],
    ]);
    expect(tools.map((tool) => tool.toolUseId)).toEqual(['native-pair', 'native-pair']);
  });
});
