/**
 * F252 adapter — cross-session tool pairing regressions.
 */

import { describe, expect, it } from 'vitest';
import { adaptTranscriptEvents } from '../adapter';
import { makeEvent } from './adapter-test-helpers';

describe('F252 adapter — cross-session orphan pairing (P1 fix)', () => {
  it('scopes no-id orphan pairing by sessionId — interleaved sessions do not mis-pair', () => {
    const events = [
      makeEvent(
        0,
        1000,
        { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo a' } },
        { sessionId: 'session-a' },
      ),
      makeEvent(
        1,
        1500,
        { type: 'tool_use', toolName: 'Read', toolInput: { path: '/b.ts' } },
        { sessionId: 'session-b' },
      ),
      makeEvent(2, 2000, { type: 'tool_result', content: 'output-from-a' }, { sessionId: 'session-a' }),
      makeEvent(3, 2500, { type: 'tool_result', content: 'file-content-b' }, { sessionId: 'session-b' }),
    ];
    const result = adaptTranscriptEvents(events);

    const toolCalls = result.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolName).toBe('Bash');
    expect(toolCalls[0]?.toolResult).toBe('output-from-a');
    expect(toolCalls[1]?.toolName).toBe('Read');
    expect(toolCalls[1]?.toolResult).toBe('file-content-b');
  });

  it('still pairs within same session when events are sequential', () => {
    const events = [
      makeEvent(0, 1000, { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'pwd' } }),
      makeEvent(1, 2000, { type: 'tool_result', content: '/home' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.toolResult).toBe('/home');
  });
});

describe('F252 adapter — cross-session id-based pairing (cloud R3 P1)', () => {
  it('scopes toolUseId pairing by sessionId — AGY run-command-N collisions do not mis-pair', () => {
    const events = [
      makeEvent(
        0,
        1000,
        {
          type: 'tool_use',
          toolName: 'run_command',
          toolUseId: 'run-command-0',
          toolInput: { CommandLine: 'echo session-a' },
        },
        { sessionId: 'session-a' },
      ),
      makeEvent(
        1,
        1500,
        { type: 'tool_result', toolUseId: 'run-command-0', content: 'session-a-output' },
        { sessionId: 'session-a' },
      ),
      makeEvent(
        2,
        2000,
        {
          type: 'tool_use',
          toolName: 'run_command',
          toolUseId: 'run-command-0',
          toolInput: { CommandLine: 'echo session-b' },
        },
        { sessionId: 'session-b' },
      ),
      makeEvent(
        3,
        2500,
        { type: 'tool_result', toolUseId: 'run-command-0', content: 'session-b-output' },
        { sessionId: 'session-b' },
      ),
    ];
    const result = adaptTranscriptEvents(events);

    const toolCalls = result.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolResult).toBe('session-a-output');
    expect(toolCalls[1]?.toolResult).toBe('session-b-output');
  });

  it('still pairs by toolUseId within same session (no regression)', () => {
    const events = [
      makeEvent(0, 1000, {
        type: 'tool_use',
        toolName: 'Read',
        toolUseId: 'toolu_abc',
        input: '{"path":"/a.ts"}',
      }),
      makeEvent(1, 2000, {
        type: 'tool_result',
        toolUseId: 'toolu_abc',
        content: 'file content',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.toolResult).toBe('file content');
  });

  it('handles three sessions with identical toolUseIds (run-command-0, run-command-1)', () => {
    const events = [
      makeEvent(
        0,
        1000,
        { type: 'tool_use', toolName: 'run_command', toolUseId: 'run-command-0', toolInput: {} },
        { sessionId: 'sa' },
      ),
      makeEvent(1, 1100, { type: 'tool_result', toolUseId: 'run-command-0', content: 'a0' }, { sessionId: 'sa' }),
      makeEvent(
        2,
        1200,
        { type: 'tool_use', toolName: 'run_command', toolUseId: 'run-command-1', toolInput: {} },
        { sessionId: 'sa' },
      ),
      makeEvent(3, 1300, { type: 'tool_result', toolUseId: 'run-command-1', content: 'a1' }, { sessionId: 'sa' }),
      makeEvent(
        4,
        2000,
        { type: 'tool_use', toolName: 'run_command', toolUseId: 'run-command-0', toolInput: {} },
        { sessionId: 'sb' },
      ),
      makeEvent(5, 2100, { type: 'tool_result', toolUseId: 'run-command-0', content: 'b0' }, { sessionId: 'sb' }),
      makeEvent(
        6,
        2200,
        { type: 'tool_use', toolName: 'run_command', toolUseId: 'run-command-1', toolInput: {} },
        { sessionId: 'sb' },
      ),
      makeEvent(7, 2300, { type: 'tool_result', toolUseId: 'run-command-1', content: 'b1' }, { sessionId: 'sb' }),
      makeEvent(
        8,
        3000,
        { type: 'tool_use', toolName: 'run_command', toolUseId: 'run-command-0', toolInput: {} },
        { sessionId: 'sc' },
      ),
      makeEvent(9, 3100, { type: 'tool_result', toolUseId: 'run-command-0', content: 'c0' }, { sessionId: 'sc' }),
    ];
    const result = adaptTranscriptEvents(events);

    const toolCalls = result.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(5);
    expect(toolCalls.map((tc) => tc.toolResult)).toEqual(['a0', 'a1', 'b0', 'b1', 'c0']);
  });
});
