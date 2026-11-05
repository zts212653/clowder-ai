import { expect, it } from 'vitest';
import { buildInvocationTimelineRows } from '@/components/workspace/trajectory/invocation-trajectory-model';
import type { ChatMessage, ToolEvent } from '@/stores/chat-types';
import { adaptTranscriptEvents } from '../adapter';
import { chatMessagesToTranscriptEvents } from '../thread-message-events';
import { makeEvent as makeRawEvent } from './adapter-test-helpers';

function makeEvent(...args: Parameters<typeof makeRawEvent>) {
  return { ...makeRawEvent(...args), catId: 'opus' };
}

const use = (invocationId: string, id = 'same') => ({
  type: 'tool_use',
  toolName: 'Bash',
  toolUseId: id,
  toolInput: { command: `pending-${invocationId}` },
});
const result = (invocationId: string, id = 'same') => ({
  type: 'tool_result',
  toolName: 'Bash',
  toolUseId: id,
  toolInput: { command: `final-${invocationId}` },
  content: `out-${invocationId}`,
});
it('does not let a later execution overwrite an earlier replay call with a reused native ID', () => {
  const raw = [
    makeEvent(0, 1, use('one'), { invocationId: 'one' }),
    makeEvent(1, 2, result('one'), { invocationId: 'one' }),
    makeEvent(2, 3, use('two'), { invocationId: 'two' }),
    makeEvent(3, 4, result('two'), { invocationId: 'two' }),
  ];
  expect(adaptTranscriptEvents(raw).map((item) => [item.toolInput, item.toolResult])).toEqual([
    ['{"command":"final-one"}', 'out-one'],
    ['{"command":"final-two"}', 'out-two'],
  ]);
});
it('preserves tool execution identity through Hub message history replay', () => {
  const tools: ToolEvent[] = ['one', 'two'].flatMap((executionRef, index) => [
    {
      id: `use-${index}`,
      type: 'tool_use' as const,
      label: 'Bash',
      toolUseId: 'same',
      executionRef,
      detail: '{"command":"pending"}',
      timestamp: index * 2 + 1,
    },
    {
      id: `result-${index}`,
      type: 'tool_result' as const,
      label: 'result',
      toolUseId: 'same',
      executionRef,
      inputDetail: JSON.stringify({ command: `final-${executionRef}` }),
      detail: `out-${executionRef}`,
      timestamp: index * 2 + 2,
    },
  ]);
  const messages: ChatMessage[] = [
    { id: 'fixture-message', type: 'assistant', catId: 'opus', content: '', timestamp: 1, toolEvents: tools },
  ];
  const replay = adaptTranscriptEvents(chatMessagesToTranscriptEvents(messages, 'thread-1')).filter(
    (item) => item.type === 'tool_call',
  );
  expect(replay.map((item) => [item.toolInput, item.toolResult])).toEqual([
    ['{"command":"final-one"}', 'out-one'],
    ['{"command":"final-two"}', 'out-two'],
  ]);
});
it('pairs sequential legacy reuse without a future result replacing the prior input', () => {
  const raw = [
    makeEvent(0, 1, use('one')),
    makeEvent(1, 2, result('one')),
    makeEvent(2, 3, use('two')),
    makeEvent(3, 4, result('two')),
  ];
  expect(adaptTranscriptEvents(raw).map((item) => item.toolInput)).toEqual([
    '{"command":"final-one"}',
    '{"command":"final-two"}',
  ]);
});
it('keeps an explicit orphan trajectory result away from a same-name pending call', () => {
  const raw = [makeEvent(0, 1, use('one', 'wanted')), makeEvent(1, 2, result('wrong', 'other-id'))];
  const rows = buildInvocationTimelineRows(raw).allRows.filter((item) => item.kind === 'tool');
  expect(rows[0]).toMatchObject({ toolUseId: 'wanted', input: { command: 'pending-one' } });
  expect(rows[0]).not.toHaveProperty('result');
  expect(rows).toHaveLength(2);
});
it('separates concurrent trajectory calls by execution when their native IDs match', () => {
  const raw = [
    makeEvent(0, 1, use('one'), { invocationId: 'one' }),
    makeEvent(1, 2, use('two'), { invocationId: 'two' }),
    makeEvent(2, 3, result('one'), { invocationId: 'one' }),
    makeEvent(3, 4, result('two'), { invocationId: 'two' }),
  ];
  const rows = buildInvocationTimelineRows(raw).allRows.filter((item) => item.kind === 'tool');
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => [row.input, row.result])).toEqual([
    [{ command: 'final-one' }, 'out-one'],
    [{ command: 'final-two' }, 'out-two'],
  ]);
});
