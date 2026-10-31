import {
  MAX_MESSAGE_OUTPUT_REFS,
  MAX_MESSAGE_OUTPUT_RUNS,
  type MessageOutputOwner,
  type OutputMessageIdentity,
  readHostSignatureOutput,
  readOutputMessageIdentity,
  sameOutputMessageIdentity,
} from '@cat-cafe/shared';
import type { MessageOutputState, MessageOutputTextInput, OutputTextRun } from './message-output-state.js';

export { materializeMessageOutput } from './message-output-materializer.js';

export function createMessageOutputState(owner: MessageOutputOwner): MessageOutputState {
  return { owner, entries: [] };
}

function observationReason(validPrefix: boolean, mode: unknown, identity: unknown, complete: unknown) {
  if (!validPrefix || (mode !== 'append' && mode !== 'replace')) return 'conflict' as const;
  if (complete !== undefined && typeof complete !== 'boolean') return 'conflict' as const;
  if (!identity) return 'unknown_output' as const;
  // Missing channels remain unavailable at materialization. They are not a
  // permanent conflict: a native item may reveal its phase at completion.
  return undefined;
}

function outputMetadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function observation(input: MessageOutputTextInput) {
  const metadata = outputMetadata(input.outputMessage);
  const identity = readOutputMessageIdentity(metadata);
  const channel: OutputTextRun['channel'] =
    metadata?.channel === 'commentary' || metadata?.channel === 'final' ? metadata.channel : undefined;
  // Outer textMode replaces the whole bubble. Native textMode applies only to this run.
  const nativeMode = metadata?.textMode === undefined ? 'append' : metadata.textMode;
  const mode = input.fragment?.mode ?? nativeMode;
  const prefix = input.fragment?.mode === 'append' ? undefined : metadata?.displayPrefixLength;
  const validPrefix = prefix === undefined || (prefix === 2 && input.content.startsWith('\n\n'));
  return {
    identity,
    channel,
    complete: metadata?.complete === true && (input.fragment?.complete ?? true),
    mode,
    displayPrefix: prefix === 2 && validPrefix,
    text: prefix === 2 && validPrefix ? input.content.slice(2) : input.content,
    reason:
      observationReason(validPrefix, nativeMode, identity, metadata?.complete) ??
      (input.fragment?.changed ? ('content_changed' as const) : undefined),
  };
}

function appendRun(state: MessageOutputState, run: OutputTextRun): MessageOutputState {
  const last = state.entries.at(-1);
  const hasText = state.entries.some((entry) => entry.kind === 'text' && entry.text.length > 0);
  return {
    ...state,
    entries: [
      ...state.entries,
      { ...run, paragraphBoundary: hasText && (run.displayPrefix || last?.kind === 'tool' || !!run.identity) },
    ],
    ...(state.entries.filter((entry) => entry.kind === 'text').length >= MAX_MESSAGE_OUTPUT_RUNS
      ? { reason: 'oversized' }
      : {}),
  };
}

type Observation = ReturnType<typeof observation>;

function continuesAcrossTools(
  state: MessageOutputState,
  next: Observation,
  index: number,
  previous: OutputTextRun,
  signatureSuffix?: string,
) {
  // One native run stays anchored at its first text observation; late command
  // results retain their arrival order. Only a proven producer signature removal
  // may shorten the observed text; ordinary prefix truncation remains conflict.
  const removedOwnSignature = signatureSuffix !== undefined && (next.text + signatureSuffix).startsWith(previous.text);
  return (
    state.entries.slice(index + 1).every((entry) => entry.kind === 'tool') &&
    (next.mode === 'append' || next.text.startsWith(previous.text) || removedOwnSignature)
  );
}

function duplicateCompletion(previous: OutputTextRun, next: Observation): boolean {
  return (
    previous.complete &&
    next.complete &&
    previous.channel === next.channel &&
    next.mode === 'replace' &&
    previous.text === next.text
  );
}

function latestNativeRunIndex(state: MessageOutputState, identity: OutputMessageIdentity, next: Observation): number {
  let latest = -1;
  const completion = next.complete && next.mode === 'replace';
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry.kind !== 'text' || !entry.identity || !sameOutputMessageIdentity(entry.identity, identity)) continue;
    // A retry of either side of a past conflict is still a duplicate, even if
    // the other observation was more recent. New fragments use the latest run.
    if (!completion || duplicateCompletion(entry, next)) return index;
    if (latest < 0) latest = index;
  }
  return latest;
}

function updateExistingRun(
  state: MessageOutputState,
  next: Observation,
  index: number,
  previous: OutputTextRun,
  signatureSuffix?: string,
): MessageOutputState {
  const sameChannel = previous.channel === next.channel;
  const observedChannel = previous.channel === undefined && next.channel !== undefined && !previous.complete;
  if (duplicateCompletion(previous, next))
    return next.reason ? { ...state, reason: state.reason ?? next.reason } : state;
  const conflictingObservation = next.reason && next.reason !== 'content_changed';
  if (
    (!sameChannel && !observedChannel) ||
    previous.complete ||
    (index !== state.entries.length - 1 && !continuesAcrossTools(state, next, index, previous, signatureSuffix)) ||
    conflictingObservation
  ) {
    // Contradictory public text remains readable, with no classification claim.
    return appendRun({ ...state, reason: 'conflict' }, { kind: 'text', ...next, paragraphBoundary: true });
  }
  const entries = [...state.entries];
  entries[index] = {
    ...previous,
    channel: next.channel,
    text: next.mode === 'replace' ? next.text : previous.text + next.text,
    complete: next.complete,
    displayPrefix: previous.displayPrefix || next.displayPrefix,
  };
  return { ...state, entries, ...(next.reason ? { reason: state.reason ?? next.reason } : {}) };
}

function appendUnobservedRun(state: MessageOutputState, next: Observation): MessageOutputState {
  const last = state.entries.at(-1);
  if (!next.identity && !next.displayPrefix && last?.kind === 'text' && !last.identity) {
    return { ...state, entries: [...state.entries.slice(0, -1), { ...last, text: last.text + next.text }] };
  }
  return appendRun(state, { kind: 'text', ...next, paragraphBoundary: false });
}

function invalidOuterMode(mode: unknown): boolean {
  return mode !== undefined && mode !== 'append' && mode !== 'replace';
}

function accumulateHostTail(state: MessageOutputState, input: MessageOutputTextInput): MessageOutputState {
  const host = readHostSignatureOutput(input.hostOutput);
  const previous = state.entries.filter((entry) => entry.kind === 'text').at(-1);
  const valid =
    host &&
    input.outputMessage === undefined &&
    (input.textMode === undefined || input.textMode === 'append') &&
    input.content.startsWith('\n\n') &&
    input.content.length > 2 &&
    !state.entries.some((entry) => entry.kind === 'host');
  if (!valid) return appendUnobservedRun({ ...state, reason: 'conflict' }, observation({ content: input.content }));
  const noFinal = previous?.kind !== 'text' || previous.channel !== 'final' || !previous.complete;
  return {
    ...state,
    entries: [...state.entries, { kind: 'host', text: input.content, observation: host }],
    ...(state.reason
      ? {}
      : noFinal
        ? { reason: 'no_final' }
        : input.fragment?.changed
          ? { reason: 'content_changed' }
          : {}),
  };
}

export function accumulateMessageOutputText(
  state: MessageOutputState,
  input: MessageOutputTextInput,
): MessageOutputState {
  if (input.hostOutput !== undefined) return accumulateHostTail(state, input);
  const next = observation(input);
  if (state.entries.some((entry) => entry.kind === 'host'))
    return appendUnobservedRun({ ...state, reason: 'conflict' }, next);
  // Empty legacy fragments do not consume a pending tool separator.
  if (!input.content && !next.identity && input.textMode !== 'replace') return state;
  if (!next.identity && input.textMode === 'replace') {
    return {
      ...state,
      reason: 'whole_body_replaced',
      entries: [
        ...state.entries.filter((entry) => entry.kind === 'tool'),
        { kind: 'text', text: input.content, complete: false, paragraphBoundary: false, displayPrefix: false },
      ],
    };
  }
  const identity = next.identity;
  const index = identity ? latestNativeRunIndex(state, identity, next) : -1;
  const previous = state.entries[index];
  if (previous?.kind === 'text') return updateExistingRun(state, next, index, previous, input.nativeSignatureSuffix);
  const reason = state.reason ?? next.reason ?? (invalidOuterMode(input.textMode) ? 'conflict' : undefined);
  return appendUnobservedRun({ ...state, ...(reason ? { reason } : {}) }, next);
}

export function accumulateMessageOutputTool(
  state: MessageOutputState,
  toolEventId: string,
  executionRef: string,
): MessageOutputState {
  if (executionRef === state.owner.turnInvocationId && state.entries.some((entry) => entry.kind === 'host'))
    state = { ...state, reason: 'conflict' };
  const previous = state.entries.find((entry) => entry.kind === 'tool' && entry.toolEventId === toolEventId);
  if (previous?.kind === 'tool')
    return previous.executionRef === executionRef ? state : { ...state, reason: 'conflict' };
  return {
    ...state,
    entries: [...state.entries, { kind: 'tool', toolEventId, executionRef }],
    ...(state.entries.length >= MAX_MESSAGE_OUTPUT_REFS ? { reason: 'oversized' } : {}),
  };
}
