import type { HandoffInvocationSummary } from '../domains/cats/services/session/TranscriptFormatter.js';
import type { ReadEventsResult, TranscriptEvent } from '../domains/cats/services/session/TranscriptReader.js';

export const SESSION_EVENT_RESPONSE_MAX_CHARS = 24_000;
const EVENT_SLICE_CHARS = 8_000;

type EventPlaceholder = Pick<TranscriptEvent, 'eventNo' | 'invocationId'> & {
  oversized: true;
  eventChars: number;
  drillDown: {
    tool: 'cat_cafe_read_session_events';
    args: { sessionId: string; cursor: number; limit: 1; view: 'raw'; charOffset: 0 };
  };
};

function payload(events: Array<TranscriptEvent | EventPlaceholder>, total: number, nextEventNo?: number) {
  return { events, total, ...(nextEventNo === undefined ? {} : { nextCursor: { eventNo: nextEventNo } }) };
}

/** Pages by the existing eventNo order; a single large event gets an exact character drill. */
export function projectRawTranscriptPage(result: ReadEventsResult, sessionId: string) {
  const selected: Array<TranscriptEvent | EventPlaceholder> = [];
  let firstOmittedEventNo: number | undefined;
  for (const event of result.events) {
    const candidate = payload([...selected, event], result.total, result.nextCursor?.eventNo);
    if (JSON.stringify(candidate).length <= SESSION_EVENT_RESPONSE_MAX_CHARS) {
      selected.push(event);
      continue;
    }
    if (selected.length > 0) {
      firstOmittedEventNo = event.eventNo;
      break;
    }
    const placeholder: EventPlaceholder = {
      eventNo: event.eventNo,
      ...(event.invocationId ? { invocationId: event.invocationId } : {}),
      oversized: true,
      eventChars: JSON.stringify(event.event).length,
      drillDown: {
        tool: 'cat_cafe_read_session_events',
        args: { sessionId, cursor: event.eventNo, limit: 1, view: 'raw', charOffset: 0 },
      },
    };
    selected.push(placeholder);
  }
  const projected = payload(selected, result.total, firstOmittedEventNo ?? result.nextCursor?.eventNo);
  if (JSON.stringify(projected).length > SESSION_EVENT_RESPONSE_MAX_CHARS) {
    throw new Error('Session event source reference cannot fit the declared response budget');
  }
  return projected;
}

/** Exact JSON representation of one source event, sliced without changing eventNo. */
export function sliceTranscriptEvent(event: TranscriptEvent, charOffset: number) {
  const serialized = JSON.stringify(event.event);
  const eventSlice = serialized.slice(charOffset, charOffset + EVENT_SLICE_CHARS);
  const nextCharOffset = charOffset + eventSlice.length;
  return {
    eventNo: event.eventNo,
    eventSlice,
    charOffset,
    totalChars: serialized.length,
    ...(nextCharOffset < serialized.length ? { nextCharOffset } : {}),
  };
}

/** A long derived summary is represented by its exact invocation source. */
export function projectHandoffTranscriptPage(
  result: { invocations: HandoffInvocationSummary[]; total: number; nextCursor?: { eventNo: number } },
  sessionId: string,
) {
  const selected: Array<
    | HandoffInvocationSummary
    | {
        invocationId: string;
        eventCount: number;
        startEventNo?: number;
        oversized: true;
        drillDown: { tool: 'cat_cafe_read_invocation_detail'; args: { sessionId: string; invocationId: string } };
      }
  > = [];
  let firstOmittedEventNo: number | undefined;
  for (const invocation of result.invocations) {
    const candidate = {
      invocations: [...selected, invocation],
      total: result.total,
      nextCursor: result.nextCursor,
    };
    if (
      JSON.stringify(candidate).length <= SESSION_EVENT_RESPONSE_MAX_CHARS &&
      JSON.stringify(invocation).length <= 1_500
    ) {
      selected.push(invocation);
      continue;
    }
    if (selected.length > 0 && invocation.startEventNo !== undefined) {
      firstOmittedEventNo = invocation.startEventNo;
      break;
    }
    selected.push({
      invocationId: invocation.invocationId,
      eventCount: invocation.eventCount,
      ...(invocation.startEventNo === undefined ? {} : { startEventNo: invocation.startEventNo }),
      oversized: true,
      drillDown: {
        tool: 'cat_cafe_read_invocation_detail',
        args: { sessionId, invocationId: invocation.invocationId },
      },
    });
  }
  return {
    invocations: selected,
    total: result.total,
    ...(firstOmittedEventNo !== undefined
      ? { nextCursor: { eventNo: firstOmittedEventNo } }
      : result.nextCursor
        ? { nextCursor: result.nextCursor }
        : {}),
  };
}
