/**
 * F252 Phase A — Adapter Tool Pairing & Regression Tests
 *
 * Orphan/positional pairing, mixed event sequences, and cloud review regressions.
 * Core adapter tests (message types, tool names, id-based pairing) are in adapter.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { adaptTranscriptEvents } from '../adapter';
import { makeEvent } from './adapter-test-helpers';

// ---------------------------------------------------------------------------
// Orphan tool pairing (no toolUseId — Codex command_execution)
// ---------------------------------------------------------------------------

describe('F252 adapter — orphan tool pairing (no toolUseId)', () => {
  it('pairs tool_use and tool_result without toolUseId via positional pairing', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        toolName: 'command_execution',
        toolInput: { command: 'ls -la' },
      }),
      makeEvent(2, 2000, {
        type: 'tool_result',
        content: 'file1.ts\nfile2.ts',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('tool_call');
    expect(result[0]?.toolName).toBe('command_execution');
    expect(result[0]?.toolResult).toBe('file1.ts\nfile2.ts');
    expect(result[0]?.toolIsError).toBe(false);
  });

  it('pairs multiple no-id tool events in positional order', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'command_execution', toolInput: { command: 'pwd' } }),
      makeEvent(2, 1500, { type: 'tool_result', content: '/home/user' }),
      makeEvent(3, 2000, { type: 'tool_use', toolName: 'command_execution', toolInput: { command: 'whoami' } }),
      makeEvent(4, 2500, { type: 'tool_result', content: 'root' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(2);
    expect(result[0]?.toolResult).toBe('/home/user');
    expect(result[1]?.toolResult).toBe('root');
  });

  it('does not cross-contaminate id-based and orphan pairing', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'Read', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(2, 1500, { type: 'tool_result', toolUseId: 'tu-1', content: 'id-matched result' }),
      makeEvent(3, 2000, { type: 'tool_use', toolName: 'command_execution', toolInput: { command: 'ls' } }),
      makeEvent(4, 2500, { type: 'tool_result', content: 'orphan result' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(2);
    expect(result[0]?.toolResult).toBe('id-matched result');
    expect(result[1]?.toolResult).toBe('orphan result');
  });
});

// ---------------------------------------------------------------------------
// Mixed event sequence
// ---------------------------------------------------------------------------

describe('F252 adapter — mixed event sequence', () => {
  it('handles interleaved messages, tool calls, and system events', () => {
    const events = [
      makeEvent(1, 1000, { type: 'session_init' }),
      makeEvent(2, 1100, { type: 'user', content: 'Fix the bug' }),
      makeEvent(3, 1200, { type: 'assistant', content: 'Looking at the code...' }),
      makeEvent(4, 1300, { type: 'tool_use', toolName: 'Read', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(5, 1800, { type: 'tool_result', toolUseId: 'tu-1', content: 'code here' }),
      makeEvent(6, 2000, { type: 'assistant', content: 'Found it!' }),
      makeEvent(7, 2100, { type: 'done' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(6);
    expect(result.map((r) => r.type)).toEqual([
      'system', // session_init
      'message', // user
      'message', // assistant
      'tool_call', // tool_use + tool_result paired
      'message', // assistant
      'system', // done
    ]);
  });

  it('assigns monotonic indexes', () => {
    const events = [
      makeEvent(5, 1000, { type: 'user', content: 'Hi' }),
      makeEvent(10, 2000, { type: 'assistant', content: 'Hello' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.index).toBe(0);
    expect(result[1]?.index).toBe(1);
  });

  it('preserves catId and invocationId', () => {
    const events = [
      makeEvent(1, 1000, { type: 'assistant', content: 'Hi' }, { catId: 'codex', invocationId: 'inv-42' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.catId).toBe('codex');
    expect(result[0]?.invocationId).toBe('inv-42');
  });

  it('skips unknown event types gracefully', () => {
    const events = [
      makeEvent(1, 1000, { type: 'unknown_weird_type', data: 'something' }),
      makeEvent(2, 1100, { type: 'assistant', content: 'Normal message' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('Normal message');
  });

  it('extracts content from content array (Claude API format)', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'assistant',
        content: [{ type: 'text', text: 'Complex content format' }],
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.content).toBe('Complex content format');
  });
});

// ---------------------------------------------------------------------------
// Cloud R2: positional orphan pairing (file_change mis-pair)
// ---------------------------------------------------------------------------

describe('F252 adapter — positional orphan pairing (cloud R2)', () => {
  it('does not pair file_change (no result) with next command result', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        toolName: 'file_change',
        toolInput: { status: 'completed', changes: [] },
      }),
      makeEvent(2, 2000, {
        type: 'tool_use',
        toolName: 'command_execution',
        toolInput: { command: 'npm test' },
      }),
      makeEvent(3, 3000, {
        type: 'tool_result',
        content: 'Tests passed',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(2);
    expect(result[0]?.toolName).toBe('file_change');
    expect(result[0]?.toolResult).toBeUndefined();
    expect(result[1]?.toolName).toBe('command_execution');
    expect(result[1]?.toolResult).toBe('Tests passed');
  });

  it('pairs consecutive no-id tool_use events with their positionally adjacent results', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'command_execution', toolInput: { command: 'pwd' } }),
      makeEvent(2, 1500, { type: 'tool_result', content: '/home/user' }),
      makeEvent(3, 2000, { type: 'tool_use', toolName: 'file_change', toolInput: { status: 'completed' } }),
      makeEvent(4, 3000, { type: 'tool_use', toolName: 'command_execution', toolInput: { command: 'ls' } }),
      makeEvent(5, 3500, { type: 'tool_result', content: 'file1.ts' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(3);
    expect(result[0]?.toolResult).toBe('/home/user');
    expect(result[1]?.toolResult).toBeUndefined();
    expect(result[2]?.toolResult).toBe('file1.ts');
  });
});
