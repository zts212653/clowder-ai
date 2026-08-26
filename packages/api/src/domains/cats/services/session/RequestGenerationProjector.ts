import {
  type RequestGenerationAssembledEvent,
  type RequestGenerationChannelProjectionV1,
  type RequestGenerationChannelV1,
  type RequestGenerationObservedEvent,
  type RequestGenerationProjectionV1,
  type RequestGenerationSegmentState,
  type RequestGenerationSourceRef,
  type RequestGenerationTerminalEvent,
  requestGenerationAssembledEventSchema,
  requestGenerationObservedEventSchema,
  requestGenerationTerminalEventSchema,
} from '@cat-cafe/shared';
import type { TranscriptEvent } from './TranscriptReader.js';

export type RequestGenerationSourceStateResolver = (
  sourceRef: RequestGenerationSourceRef,
) => RequestGenerationSegmentState;

interface CollectedGenerationEvents {
  assembled: Map<number, RequestGenerationAssembledEvent>;
  observed: Map<number, RequestGenerationObservedEvent>;
  terminal: Map<number, RequestGenerationTerminalEvent>;
}

function sourceState(
  refs: readonly RequestGenerationSourceRef[],
  resolve: RequestGenerationSourceStateResolver | undefined,
): RequestGenerationSegmentState {
  if (!resolve || refs.length === 0) return 'redacted';
  const states = refs.map(resolve);
  if (states.includes('deleted')) return 'deleted';
  if (states.includes('redacted')) return 'redacted';
  if (states.includes('unknown')) return 'unknown';
  return 'available';
}

function projectChannel(
  channel: RequestGenerationChannelV1,
  resolve: RequestGenerationSourceStateResolver | undefined,
): RequestGenerationChannelProjectionV1 {
  if (channel.accuracy === 'unsupported') return { ...channel, state: 'unsupported' };
  if (channel.accuracy === 'unknown') return { ...channel, state: 'unknown' };
  const state = sourceState(channel.sourceRefs, resolve);
  const { body, ...metadata } = channel;
  return state === 'available'
    ? { ...metadata, state, ...(body !== undefined ? { body } : {}) }
    : { ...metadata, state };
}

function assertTranscriptIdentity(transcriptEvent: TranscriptEvent, invocationId: string | undefined): string {
  if (!transcriptEvent.invocationId) throw new Error('request_generation_invocation_id_missing');
  if (invocationId && transcriptEvent.invocationId !== invocationId) {
    throw new Error('request_generation_invocation_mixed');
  }
  return transcriptEvent.invocationId;
}

function setUnique<T>(map: Map<number, T>, ordinal: number, value: T, error: string): void {
  if (map.has(ordinal)) throw new Error(error);
  map.set(ordinal, value);
}

function collectGenerationEvents(events: readonly TranscriptEvent[]): CollectedGenerationEvents {
  const collected: CollectedGenerationEvents = {
    assembled: new Map(),
    observed: new Map(),
    terminal: new Map(),
  };
  let invocationId: string | undefined;
  for (const transcriptEvent of events) {
    const type = transcriptEvent.event.type;
    if (!String(type).startsWith('request_generation_')) continue;
    invocationId = assertTranscriptIdentity(transcriptEvent, invocationId);
    if (type === 'request_generation_assembled') {
      const event = requestGenerationAssembledEventSchema.parse(transcriptEvent.event);
      if (event.envelope.invocationId !== invocationId) throw new Error('request_generation_invocation_mismatch');
      if (event.envelope.sessionId !== transcriptEvent.sessionId)
        throw new Error('request_generation_session_mismatch');
      setUnique(collected.assembled, event.envelope.generationOrdinal, event, 'request_generation_ordinal_duplicate');
    } else if (type === 'request_generation_observed') {
      const event = requestGenerationObservedEventSchema.parse(transcriptEvent.event);
      setUnique(collected.observed, event.generationOrdinal, event, 'request_generation_observed_duplicate');
    } else if (type === 'request_generation_terminal') {
      const event = requestGenerationTerminalEventSchema.parse(transcriptEvent.event);
      setUnique(collected.terminal, event.generationOrdinal, event, 'request_generation_terminal_duplicate');
    }
  }
  return collected;
}

export function projectRequestGenerations(
  events: readonly TranscriptEvent[],
  resolveSourceState?: RequestGenerationSourceStateResolver,
): RequestGenerationProjectionV1[] {
  const { assembled, observed, terminal } = collectGenerationEvents(events);

  const ordinals = [...assembled.keys()].sort((left, right) => left - right);

  return ordinals.map((ordinal) => {
    const assembledEvent = assembled.get(ordinal);
    if (!assembledEvent) throw new Error('request_generation_assembled_missing');
    const observedEvent = observed.get(ordinal);
    const terminalEvent = terminal.get(ordinal);
    for (const event of [observedEvent, terminalEvent]) {
      if (event && event.requestGenerationId !== assembledEvent.envelope.requestGenerationId) {
        throw new Error('request_generation_identity_mismatch');
      }
    }
    return {
      envelope: {
        ...assembledEvent.envelope,
        channels: assembledEvent.envelope.channels.map((channel) => projectChannel(channel, resolveSourceState)),
      },
      ...(observedEvent ? { observed: observedEvent } : {}),
      ...(terminalEvent ? { terminal: terminalEvent } : {}),
    };
  });
}

export function projectRequestGenerationGaps(
  events: readonly TranscriptEvent[],
): import('@cat-cafe/shared').RequestGenerationGapV1[] {
  const ordinals = [...collectGenerationEvents(events).assembled.keys()].sort((left, right) => left - right);
  const gaps: import('@cat-cafe/shared').RequestGenerationGapV1[] = [];
  let expected = 1;
  for (const ordinal of ordinals) {
    if (ordinal > expected) {
      gaps.push({
        kind: 'evidence_gap',
        fromOrdinal: expected,
        toOrdinal: ordinal - 1,
        state: 'unknown',
        reason: 'ordinal_gap',
      });
    }
    expected = ordinal + 1;
  }
  return gaps;
}
