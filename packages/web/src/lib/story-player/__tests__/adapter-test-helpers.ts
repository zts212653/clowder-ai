import type { RawTranscriptEvent } from '../types';

export function makeEvent(
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
