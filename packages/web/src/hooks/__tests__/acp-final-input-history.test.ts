import { describe, expect, it } from 'vitest';
import { toCliEvents } from '@/components/cli-output/toCliEvents';
import { summarizeReplyRecord } from '@/components/reply-layers/reply-record';
import { buildInvocationTimelineRows } from '@/components/workspace/trajectory/invocation-trajectory-model';
import { adaptTranscriptEvents } from '@/lib/story-player/adapter';
import { chatMessagesToTranscriptEvents } from '@/lib/story-player/thread-message-events';
import type { ToolEvent } from '@/stores/chat-types';
import {
  flatCodexStreamBubbles,
  installActiveHarness,
  installBackgroundHarness,
  seedProcessingResponse,
  threadCodexStreamBubbles,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

const finalInput = { command: 'echo complete' };
const event = (type: 'tool_use' | 'tool_result', threadId: string, initial?: Record<string, unknown>) => ({
  type,
  catId: 'codex',
  threadId,
  messageId: `response-final-input-${threadId}`,
  invocationId: 'parent',
  turnInvocationId: 'child',
  timestamp: 1,
  toolName: 'Bash',
  toolUseId: 'native-pair',
  toolExecutionRef: 'child',
  toolEventId: type === 'tool_use' ? 'tool-api-use' : 'toolr-api-result',
  toolInput: type === 'tool_result' ? finalInput : initial,
  content: type === 'tool_result' ? 'complete' : undefined,
});
function assertVisible(tools: ToolEvent[]) {
  expect(tools).toHaveLength(2);
  expect(tools[1]).toMatchObject({ inputDetail: JSON.stringify(finalInput) });
  expect(summarizeReplyRecord(tools, undefined).rows[0].label).toBe('Bash echo complete');
  const classic = toCliEvents(JSON.parse(JSON.stringify(tools)), undefined);
  expect(classic[0]).toMatchObject({ label: 'Bash echo complete', detail: JSON.stringify(finalInput) });
  expect(classic[1].detail).toBe('complete');
}
describe('final ACP input through actual active handler', () => {
  const active = installActiveHarness();
  it.each([undefined, { command: 'ech' }])('updates visible input without reopening the call (%s)', (initial) => {
    seedProcessingResponse('thread-1', 'response-final-input-thread-1', 'codex', 'child');
    active.render();
    active.send(event('tool_use', 'thread-1', initial));
    active.send(event('tool_result', 'thread-1'));
    const messages = flatCodexStreamBubbles();
    assertVisible(messages.flatMap((message) => message.toolEvents ?? []));
    const replay = adaptTranscriptEvents(
      chatMessagesToTranscriptEvents(JSON.parse(JSON.stringify(messages)), 'thread-1'),
    );
    expect(replay.find((item) => item.type === 'tool_call')?.toolInput).toBe(JSON.stringify(finalInput));
  });
});
describe('final ACP input through background handler', () => {
  const background = installBackgroundHarness();
  it('survives thread switching with the native pair key', () => {
    seedProcessingResponse('thread-bg', 'response-final-input-thread-bg', 'codex', 'child');
    background.dispatchBg(event('tool_use', 'thread-bg'));
    background.dispatchBg(event('tool_result', 'thread-bg'));
    assertVisible(threadCodexStreamBubbles('thread-bg').flatMap((message) => message.toolEvents ?? []));
  });
});
it('replays finalized raw input in Story Player and invocation trajectory', () => {
  const base = {
    v: 1 as const,
    t: 1,
    threadId: 'fixture',
    catId: 'dsh',
    sessionId: 'fixture',
    cliSessionId: 'fixture',
  };
  const raw = [
    {
      ...base,
      eventNo: 0,
      event: { type: 'tool_use', toolName: 'Bash', toolUseId: 'call-1', toolInput: { command: 'ech' } },
    },
    {
      ...base,
      eventNo: 1,
      event: { type: 'tool_result', toolUseId: 'call-1', toolInput: finalInput, content: 'complete' },
    },
  ];
  expect(adaptTranscriptEvents(raw)[0].toolInput).toBe(JSON.stringify(finalInput));
  expect(buildInvocationTimelineRows(raw).allRows.find((row) => row.kind === 'tool')).toMatchObject({
    input: finalInput,
  });
});

it("does not attach an orphan or another execution's finalized input to the current call", () => {
  const tools: ToolEvent[] = [
    {
      id: 'use',
      type: 'tool_use',
      label: 'Bash',
      detail: '{"command":"original"}',
      toolUseId: 'same',
      executionRef: 'one',
      timestamp: 1,
    },
    {
      id: 'result',
      type: 'tool_result',
      label: 'result',
      detail: 'out',
      inputDetail: '{"command":"wrong"}',
      toolUseId: 'same',
      executionRef: 'two',
      timestamp: 2,
    },
  ];
  expect(summarizeReplyRecord(tools, undefined).rows).toEqual([
    { id: 'use', label: 'Bash original', detail: '{"command":"original"}', failed: false, settled: false },
  ]);
  expect(toCliEvents(tools, undefined)[0].label).toBe('Bash original');
});

it('retains legacy input when terminal events have no finalized input', () => {
  const tools: ToolEvent[] = [
    { id: 'use', type: 'tool_use', label: 'Bash', detail: '{"command":"original"}', toolUseId: 'same', timestamp: 1 },
    { id: 'result', type: 'tool_result', label: 'result', detail: 'out', toolUseId: 'same', timestamp: 2 },
  ];
  expect(summarizeReplyRecord(tools, undefined).rows[0]).toMatchObject({
    label: 'Bash original',
    detail: 'out',
    settled: true,
  });
});
