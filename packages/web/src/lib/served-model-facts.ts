import type { ChatMessageMetadata } from '@/stores/chat-types';

/** F319: the upstream facts a Codex turn may carry; each field is independently optional. */
export type ServedModelFacts = Pick<
  ChatMessageMetadata,
  | 'servedModel'
  | 'servedResponseId'
  | 'servedModelSource'
  | 'upstreamTurnStateLength'
  | 'upstreamSafetyBufferingFasterModel'
  | 'upstreamSafetyBuffering'
>;

const SOURCES = new Set(['sse_response_object', 'ws_response_object']);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * F319 Phase E.1: read the `served` block the API attaches to `invocation_usage`.
 * Without a non-empty `servedModel` the turn was not observed → `undefined`
 * (never an empty object, so callers cannot mistake "unobserved" for "observed, nothing").
 * Mistyped fields are dropped, not coerced.
 */
export function servedFactsFromUsagePayload(payload: Record<string, unknown>): ServedModelFacts | undefined {
  const served = payload.served;
  if (!served || typeof served !== 'object' || Array.isArray(served)) return undefined;
  const raw = served as Record<string, unknown>;
  const servedModel = nonEmptyString(raw.servedModel);
  if (!servedModel) return undefined;
  const facts: ServedModelFacts = { servedModel };
  const responseId = nonEmptyString(raw.servedResponseId);
  if (responseId) facts.servedResponseId = responseId;
  if (typeof raw.servedModelSource === 'string' && SOURCES.has(raw.servedModelSource)) {
    facts.servedModelSource = raw.servedModelSource as ServedModelFacts['servedModelSource'];
  }
  if (typeof raw.upstreamTurnStateLength === 'number' && Number.isFinite(raw.upstreamTurnStateLength)) {
    facts.upstreamTurnStateLength = raw.upstreamTurnStateLength;
  }
  const faster = nonEmptyString(raw.upstreamSafetyBufferingFasterModel);
  if (faster) facts.upstreamSafetyBufferingFasterModel = faster;
  if (typeof raw.upstreamSafetyBuffering === 'boolean') facts.upstreamSafetyBuffering = raw.upstreamSafetyBuffering;
  return facts;
}
