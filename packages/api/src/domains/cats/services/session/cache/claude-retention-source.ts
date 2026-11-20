import {
  type RequestGenerationEnvelopeV1,
  requestGenerationAssembledEventSchema,
  requestGenerationTerminalEventSchema,
  type SessionRecord,
} from '@cat-cafe/shared';
import type { ClaudeCacheRetentionReplay } from '../../agents/providers/claude-cache-retention-replay.js';
import type { TranscriptReader } from '../TranscriptReader.js';

export interface ClaudeRetentionSource extends ClaudeCacheRetentionReplay {
  readonly runtime: RequestGenerationEnvelopeV1['runtime']['requested'] & { model: string };
  readonly tools: RequestGenerationEnvelopeV1['tools'];
}

/** Read only the successful source invocation, through the existing transcript owner. */
export async function readClaudeRetentionSource(
  reader: Pick<TranscriptReader, 'readInvocationEvents'>,
  record: SessionRecord,
): Promise<ClaudeRetentionSource> {
  const source = record.lastUsage?.cacheObservation;
  if (!source || source.nativeSessionId !== record.cliSessionId) throw new Error('cache_retention_source_unavailable');
  const events = await reader.readInvocationEvents(record.id, record.threadId, record.catId, source.invocationId);
  const accepted = new Set(
    (events ?? []).flatMap((entry) => {
      const result = requestGenerationTerminalEventSchema.safeParse(entry.event);
      return result.success && result.data.outcome === 'accepted' ? [result.data.requestGenerationId] : [];
    }),
  );
  const generations = (events ?? [])
    .flatMap((entry) => {
      const result = requestGenerationAssembledEventSchema.safeParse(entry.event);
      if (!result.success) return [];
      const envelope = result.data.envelope;
      if (
        entry.invocationId !== source.invocationId ||
        entry.threadId !== record.threadId ||
        entry.catId !== record.catId ||
        envelope.invocationId !== source.invocationId ||
        envelope.sessionId !== record.id ||
        !accepted.has(envelope.requestGenerationId)
      )
        return [];
      return [envelope];
    })
    .sort((a, b) => b.generationOrdinal - a.generationOrdinal);
  const last = generations[0];
  if (
    !last ||
    last.runtime.requested.provider !== 'anthropic' ||
    !['print_sdk', 'agent_sdk'].includes(last.runtime.requested.carrier ?? '') ||
    last.runtime.requested.model !== source.model
  )
    throw new Error('cache_retention_source_unavailable');
  const l0 = last.channels.filter(
    (c) => c.channel === 'native_instruction' && c.injectionDecision === 'native_l0_compiled',
  );
  const append = last.channels.filter(
    (c) => c.channel === 'native_instruction' && c.injectionDecision === 'route_append_system_prompt',
  );
  if (
    l0.length !== 1 ||
    l0[0].accuracy !== 'exact' ||
    !l0[0].body ||
    append.length > 1 ||
    (append.length === 1 && (append[0].accuracy !== 'exact' || !append[0].body))
  )
    throw new Error('cache_retention_source_unavailable');
  return {
    sourceInvocationId: source.invocationId,
    nativeSystemPrompt: l0[0].body,
    ...(append[0]?.body ? { appendSystemPrompt: append[0].body } : {}),
    runtime: { ...last.runtime.requested, model: source.model },
    tools: last.tools,
  };
}
