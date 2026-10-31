/**
 * F252 adapter — tool result status variants.
 */

import { describe, expect, it } from 'vitest';
import { adaptTranscriptEvents } from '../adapter';
import { makeEvent } from './adapter-test-helpers';

describe('F252 adapter — toolResultStatus error detection', () => {
  it('detects toolResultStatus="error" as tool error', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'Bash', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(2, 2000, {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: 'Error: command failed',
        toolResultStatus: 'error',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.toolIsError).toBe(true);
  });

  it('detects status="error" as tool error (legacy variant)', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'Read', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(2, 1500, {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: 'Not found',
        status: 'error',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.toolIsError).toBe(true);
  });

  it('treats toolResultStatus="ok" as non-error', () => {
    const events = [
      makeEvent(1, 1000, { type: 'tool_use', toolName: 'Bash', input: '{}', toolUseId: 'tu-1' }),
      makeEvent(2, 1500, {
        type: 'tool_result',
        toolUseId: 'tu-1',
        content: 'success output',
        toolResultStatus: 'ok',
      }),
    ];
    const result = adaptTranscriptEvents(events);

    expect(result[0]?.toolIsError).toBe(false);
  });
});
