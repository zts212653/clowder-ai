/**
 * F252 Phase A — TranscriptEvent → ReplayEvent Adapter Tests
 *
 * AC-A5: adapter 正确处理 text/assistant/user 多形态事件
 *        + toolName/name 双形态工具名，有单元测试覆盖
 */
import { describe, expect, it } from 'vitest';
import { adaptTranscriptEvents } from '../adapter';
import type { RawTranscriptEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  eventNo: number,
  t: number,
  event: Record<string, unknown>,
  overrides: Partial<RawTranscriptEvent> = {},
): RawTranscriptEvent {
  return {
    v: 1,
    t,
    threadId: 'thread-1',
    catId: 'opus',
    sessionId: 'session-1',
    cliSessionId: 'cli-1',
    eventNo,
    event,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Message type normalization
// ---------------------------------------------------------------------------

describe('F252 adapter — message type normalization', () => {
  it('normalizes "assistant" event type to message role=assistant', () => {
    const events = [makeEvent(1, 1000, { type: 'assistant', content: 'Hello world' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      index: 0,
      type: 'message',
      role: 'assistant',
      content: 'Hello world',
      timestamp: 1000,
      eventNo: 1,
    });
  });

  it('normalizes "text" event type to message role=assistant', () => {
    const events = [makeEvent(1, 1000, { type: 'text', content: 'Final answer' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'Final answer',
    });
  });

  it('normalizes "user" event type to message role=user', () => {
    const events = [makeEvent(1, 1000, { type: 'user', content: 'Tell me about cats' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'Tell me about cats',
    });
  });

  it('normalizes "system" event type to system', () => {
    const events = [makeEvent(1, 1000, { type: 'system', content: 'Session started' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'system',
      role: 'system',
      content: 'Session started',
    });
  });

  it('handles thinking events', () => {
    const events = [makeEvent(1, 1000, { type: 'thinking', content: 'Let me consider...' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'thinking',
      role: 'assistant',
      content: 'Let me consider...',
    });
  });
});

// ---------------------------------------------------------------------------
// Tool name normalization (dual form: toolName / name)
// ---------------------------------------------------------------------------

describe('F252 adapter — tool name normalization', () => {
  it('normalizes toolName field', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        toolName: 'Read',
        input: JSON.stringify({ file_path: '/foo/bar.ts' }),
        toolUseId: 'tu-1',
      }),
      makeEvent(2, 1500, {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: 'file contents here',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool_call',
      toolName: 'Read',
      toolInput: JSON.stringify({ file_path: '/foo/bar.ts' }),
      toolResult: 'file contents here',
      toolIsError: false,
    });
  });

  it('normalizes name field (alternate form)', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        name: 'Bash',
        input: JSON.stringify({ command: 'ls' }),
        toolUseId: 'tu-2',
      }),
      makeEvent(2, 1200, {
        type: 'tool_result',
        toolUseId: 'tu-2',
        content: 'file1.ts\nfile2.ts',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool_call',
      toolName: 'Bash',
    });
  });

  it('prefers toolName over name when both present', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        toolName: 'Edit',
        name: 'edit_legacy',
        input: '{}',
        toolUseId: 'tu-3',
      }),
      makeEvent(2, 1100, {
        type: 'tool_result',
        toolUseId: 'tu-3',
        content: 'ok',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.toolName).toBe('Edit');
  });
});

// ---------------------------------------------------------------------------
// Tool use/result pairing
// ---------------------------------------------------------------------------

describe('F252 adapter — tool_use + tool_result pairing', () => {
  it('pairs tool_use with matching tool_result by toolUseId', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'Read', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(2, 2000, { type: 'tool_result', toolUseId: 'tu-1', content: 'result data' }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.toolResult).toBe('result data');
    // Timestamp should be from the tool_use event
    expect(result[0]?.timestamp).toBe(1000);
  });

  it('marks error tool results', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'Bash', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(2, 2000, { type: 'tool_result', toolUseId: 'tu-1', content: 'Error: not found', is_error: true }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.toolIsError).toBe(true);
  });

  it('handles orphan tool_use (no matching result)', () => {
    const events = [makeEvent(1, 1000, { type: 'tool_use', toolName: 'Read', input: '{}', toolUseId: 'tu-orphan' })];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.toolResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1-3 regression: structured tool payloads (R1 review)
// ---------------------------------------------------------------------------

describe('F252 adapter — structured tool payloads (P1-3 regression)', () => {
  it('preserves Record-typed toolInput as JSON string', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        toolName: 'Read',
        toolInput: { file_path: '/foo/bar.ts', limit: 100 },
        toolUseId: 'tu-record',
      }),
      makeEvent(2, 1500, {
        type: 'tool_result',
        toolUseId: 'tu-record',
        content: 'file contents',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]?.toolInput).toBeDefined();
    // Should be JSON stringified
    const parsed = JSON.parse(result[0]?.toolInput ?? '{}');
    expect(parsed.file_path).toBe('/foo/bar.ts');
    expect(parsed.limit).toBe(100);
  });

  it('handles input field (legacy) with Record value', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'ls -la' },
        toolUseId: 'tu-legacy',
      }),
      makeEvent(2, 1200, {
        type: 'tool_result',
        toolUseId: 'tu-legacy',
        content: 'output',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.toolInput).toBeDefined();
    const parsed = JSON.parse(result[0]?.toolInput ?? '{}');
    expect(parsed.command).toBe('ls -la');
  });

  it('prefers toolInput over input when both present', () => {
    const events = [
      makeEvent(1, 1000, {
        type: 'tool_use',
        toolName: 'Edit',
        toolInput: { file_path: '/a.ts', old_string: 'x' },
        input: { file_path: '/b.ts' },
        toolUseId: 'tu-both',
      }),
      makeEvent(2, 1100, {
        type: 'tool_result',
        toolUseId: 'tu-both',
        content: 'ok',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    const parsed = JSON.parse(result[0]?.toolInput ?? '{}');
    expect(parsed.file_path).toBe('/a.ts');
  });
});

// ---------------------------------------------------------------------------
// AC-E5: sourceThreadId preservation
// ---------------------------------------------------------------------------

describe('sourceThreadId preservation (AC-E5)', () => {
  it('carries raw threadId onto adapted event as sourceThreadId', () => {
    const events = [makeEvent(0, 1000, { type: 'text', content: 'hello' }, { threadId: 'thread-abc' })];
    const result = adaptTranscriptEvents(events);
    expect(result[0].sourceThreadId).toBe('thread-abc');
  });

  it('preserves different threadIds across events', () => {
    const events = [
      makeEvent(0, 1000, { type: 'text', content: 'a' }, { threadId: 'thread-1' }),
      makeEvent(1, 2000, { type: 'text', content: 'b' }, { threadId: 'thread-2' }),
    ];
    const result = adaptTranscriptEvents(events);
    expect(result[0].sourceThreadId).toBe('thread-1');
    expect(result[1].sourceThreadId).toBe('thread-2');
  });
});

// Pairing, mixed event, and regression tests moved to adapter-pairing.test.ts
