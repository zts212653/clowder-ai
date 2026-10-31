export const SESSION_TOOL_RESPONSE_MAX_CHARS = 24_000;

export interface SessionEventView {
  eventNo: number;
  event?: Record<string, unknown>;
  oversized?: boolean;
  eventChars?: number;
}

/** Preserves the raw eventNo continuation when the MCP rendering needs a smaller page. */
export function renderRawSessionEvents(input: {
  sessionId: string;
  events: SessionEventView[];
  total: number;
  nextCursor?: { eventNo: number };
}): string {
  const body: string[] = [];
  let firstOmittedEventNo: number | undefined;
  for (const event of input.events) {
    const eventJson = event.event === undefined ? undefined : JSON.stringify(event.event);
    const line =
      event.oversized || (eventJson?.length ?? 0) > 18_000
        ? `[${event.eventNo}] oversized event (${event.eventChars ?? eventJson?.length ?? 'unknown'} chars); drill: cat_cafe_read_session_events(sessionId=${JSON.stringify(input.sessionId)}, cursor=${event.eventNo}, limit=1, view="raw", charOffset=0)`
        : `[${event.eventNo}] ${String(event.event?.['type'] ?? 'unknown')}: ${eventJson ?? '[source event unavailable]'}`;
    const tentative = [
      `Total events: ${input.total}, returned: ${body.length + 1}`,
      'Next cursor: 9999999999',
      '',
      ...body,
      line,
    ].join('\n');
    if (tentative.length > SESSION_TOOL_RESPONSE_MAX_CHARS) {
      firstOmittedEventNo = event.eventNo;
      break;
    }
    body.push(line);
  }
  const next = firstOmittedEventNo ?? input.nextCursor?.eventNo;
  const lines = [
    `Total events: ${input.total}, returned: ${body.length}`,
    ...(next === undefined ? [] : [`Next cursor: ${next}`]),
    '',
    ...body,
  ];
  return lines.join('\n');
}

export function renderChatSessionEvents(input: {
  sessionId: string;
  messages: Array<{ eventNo?: number; role: string; content?: string; contentLength?: number; oversized?: boolean }>;
  total: number;
  nextCursor?: { eventNo: number };
}): string {
  const body: string[] = [];
  let firstOmitted: number | undefined;
  let locallyOmitted = false;
  for (const message of input.messages) {
    const content = message.content ?? '';
    const line =
      message.oversized || content.length > 18_000
        ? `[${message.eventNo ?? '?'}] ${message.role}: oversized chat body (${message.contentLength ?? content.length} chars); ${
            message.eventNo === undefined
              ? 'exact raw event number unavailable'
              : `drill: cat_cafe_read_session_events(sessionId=${JSON.stringify(input.sessionId)}, cursor=${message.eventNo}, limit=1, view="raw", charOffset=0)`
          }`
        : `[${message.eventNo ?? '?'} ${message.role}] ${content}`;
    if ([...body, line].join('\n').length + 200 > SESSION_TOOL_RESPONSE_MAX_CHARS) {
      firstOmitted = message.eventNo;
      locallyOmitted = true;
      break;
    }
    body.push(line);
  }
  const next = locallyOmitted ? firstOmitted : input.nextCursor?.eventNo;
  return [
    `Total events: ${input.total}, messages: ${body.length}`,
    ...(next === undefined ? [] : [`Next cursor: ${next}`]),
    ...(locallyOmitted && next === undefined
      ? ['⚠️ Additional chat messages omitted; source event number unavailable.']
      : []),
    '',
    ...body,
  ].join('\n');
}

export function renderHandoffSessionEvents(input: {
  sessionId: string;
  invocations: Array<{
    invocationId: string;
    startEventNo?: number;
    eventCount: number;
    errors?: number;
    durationMs?: number;
    toolCalls?: string[];
    keyMessages?: string[];
    oversized?: boolean;
  }>;
  total: number;
  nextCursor?: { eventNo: number };
}): string {
  const body: string[] = [];
  let firstOmitted: number | undefined;
  let locallyOmitted = false;
  for (const invocation of input.invocations) {
    const full = [
      `--- Invocation ${invocation.invocationId} (${invocation.eventCount} events) ---`,
      `  Errors: ${invocation.errors ?? 0}; durationMs: ${invocation.durationMs ?? 0}`,
      ...(invocation.toolCalls?.length ? [`  Tools: ${invocation.toolCalls.join(', ')}`] : []),
      ...(invocation.keyMessages ?? []).map((message) => `  > ${message}`),
    ].join('\n');
    const line =
      invocation.oversized || full.length > 1_500
        ? `--- Invocation ${invocation.invocationId} (${invocation.eventCount} events) ---\n  Summary oversized; drill: cat_cafe_read_invocation_detail(sessionId=${JSON.stringify(input.sessionId)}, invocationId=${JSON.stringify(invocation.invocationId)})`
        : full;
    if ([...body, line].join('\n').length + 200 > SESSION_TOOL_RESPONSE_MAX_CHARS) {
      firstOmitted = invocation.startEventNo;
      locallyOmitted = true;
      break;
    }
    body.push(line);
  }
  const next = locallyOmitted ? firstOmitted : input.nextCursor?.eventNo;
  return [
    `Total events: ${input.total}, invocations: ${body.length}`,
    ...(next === undefined ? [] : [`Next cursor: ${next}`]),
    ...(locallyOmitted && next === undefined
      ? ['⚠️ Additional invocation summaries omitted; source event number unavailable.']
      : []),
    '',
    ...body,
  ].join('\n');
}
