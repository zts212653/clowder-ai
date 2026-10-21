export interface TranscriptToolIdentity {
  threadId: string;
  catId?: string;
  sessionId: string;
  invocationId?: string;
  event: Record<string, unknown>;
}

/** Explicit child execution wins over parent envelopes; legacy data stays session-scoped. */
export function transcriptToolScope(envelope: TranscriptToolIdentity): string {
  const execution = [
    envelope.event.toolExecutionRef,
    envelope.event.executionRef,
    envelope.event.turnInvocationId,
    envelope.invocationId,
  ].find((value) => typeof value === 'string' && value.length > 0);
  return JSON.stringify([envelope.threadId, envelope.catId ?? '', envelope.sessionId, execution ?? '']);
}

export function transcriptToolCallKey(
  envelope: TranscriptToolIdentity,
  nativeId: unknown = envelope.event.toolUseId ?? envelope.event.tool_use_id,
): string | undefined {
  return typeof nativeId === 'string' && nativeId.length > 0
    ? JSON.stringify([transcriptToolScope(envelope), nativeId])
    : undefined;
}
