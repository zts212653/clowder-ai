import type { CliDiagnostics } from '@cat-cafe/shared';
import { isCliError, isCliTimeout, isLivenessWarning } from '../../../../../../../utils/cli-spawn.js';
import type { LivenessWarningEvent } from '../../../../../../../utils/ProcessLivenessProbe.js';
import {
  type AgyStreamJsonEvent,
  type AgyStreamJsonTurn,
  parseAgyStreamJsonLine,
  summarizeAgyStreamJsonTurn,
} from '../../agy-stream-json-parser.js';
import { agyNativePolicyDiagnostics, missingAgyNativeInitError } from '../agy-native-errors.js';
import {
  type ExpectedNativeInit,
  readAgyNativeEnvelope,
  verifiedInitSessionId,
  verifyAgyNativeResult,
} from '../agy-native-stream-validation.js';

export interface AgyNativeObservedTurn {
  readonly sessionId: string;
  readonly turn: AgyStreamJsonTurn;
  readonly transportError: string | null;
  readonly cliDiagnostics?: CliDiagnostics;
  readonly transportExit?: { readonly code: number | null; readonly signal: string | null };
  readonly cancelledBeforeTerminal?: boolean;
}

export type AgyNativeStreamObservation =
  | { readonly kind: 'init'; readonly sessionId: string }
  | { readonly kind: 'step'; readonly event: Extract<AgyStreamJsonEvent, { kind: 'step' }> }
  | { readonly kind: 'liveness'; readonly warning: LivenessWarningEvent }
  | { readonly kind: 'result'; readonly observed: AgyNativeObservedTurn }
  | { readonly kind: 'complete'; readonly observed: AgyNativeObservedTurn };

const MAX_AGY_NATIVE_STREAM_CHARS = 8 * 1024 * 1024;
function verifiedNativeTerminal(lines: readonly string[], sessionId: string, resultCount: number): AgyStreamJsonTurn {
  if (resultCount > 1) throw new Error('AGY native one-turn process emitted multiple terminal results');
  const turn = summarizeAgyStreamJsonTurn(lines);
  if (turn.conversationId && turn.conversationId !== sessionId) {
    throw new Error('AGY native terminal conversation ID disagrees with init');
  }
  return turn;
}

/** Treat init as a claim that must match the launch plan, never as proof that L0 reached the model. */
export async function* observeAgyNativeTurn(
  stream: AsyncIterable<unknown>,
  expected: ExpectedNativeInit,
  signal?: AbortSignal,
  multiTurn = false,
): AsyncGenerator<AgyNativeStreamObservation> {
  const lines: string[] = [];
  let sessionId: string | null = null;
  let transportError: string | null = null;
  let cliDiagnostics: CliDiagnostics | undefined;
  let transportExit: AgyNativeObservedTurn['transportExit'];
  let resultCount = 0;
  let resultSeenBeforeCancellation = false;
  let streamChars = 0;
  for await (const raw of stream) {
    if (isCliError(raw) || isCliTimeout(raw)) {
      cliDiagnostics = raw.cliDiagnostics;
      transportExit = !transportError && isCliError(raw) ? { code: raw.exitCode, signal: raw.signal } : undefined;
      transportError = raw.message;
      continue;
    }
    if (isLivenessWarning(raw)) {
      yield { kind: 'liveness', warning: raw };
      continue;
    }
    const record = readAgyNativeEnvelope(raw);
    if (record.event === 'init') {
      if (resultCount > 0) throw new Error('AGY native init followed a terminal result');
      sessionId = verifiedInitSessionId(record, expected, sessionId !== null);
      yield { kind: 'init', sessionId };
    }
    const line = JSON.stringify(raw);
    const event = parseAgyStreamJsonLine(line);
    if (resultCount > 0 && record.event !== 'init') {
      if (
        !multiTurn ||
        event?.kind !== 'step' ||
        event.stepType !== 'user_input' ||
        event.conversationId !== sessionId
      ) {
        if (record.event === 'result') throw new Error('AGY native one-turn process emitted multiple terminal results');
        throw new Error('AGY native step has no matching verified init or next user input');
      }
      lines.length = 0;
      resultCount = 0;
      resultSeenBeforeCancellation = false;
    }
    if (record.event === 'result') {
      if (sessionId) verifyAgyNativeResult(record, sessionId);
      resultCount++;
      if (!signal?.aborted) resultSeenBeforeCancellation = true;
    }
    streamChars += line.length;
    if (streamChars > MAX_AGY_NATIVE_STREAM_CHARS)
      throw new Error('AGY native stream exceeded the bounded output limit');
    lines.push(line);
    if (event?.kind === 'step') {
      if (!sessionId || event.conversationId !== sessionId || resultCount > 0) {
        throw new Error('AGY native step has no matching verified init');
      }
      yield { kind: 'step', event };
    }
    if (record.event === 'result' && sessionId) {
      yield {
        kind: 'result',
        observed: {
          sessionId,
          turn: verifiedNativeTerminal(lines, sessionId, resultCount),
          transportError,
          cancelledBeforeTerminal: signal?.aborted === true && !resultSeenBeforeCancellation,
        },
      };
    }
  }
  const debugRef = {
    command: expected.command ?? 'agy',
    signal: transportExit?.signal ?? null,
    ...(transportExit ? { exitCode: transportExit.code } : {}),
    ...(expected.invocationId ? { invocationId: expected.invocationId } : {}),
  };
  if (!sessionId) throw missingAgyNativeInitError(lines, transportError, cliDiagnostics, debugRef);
  const turn = verifiedNativeTerminal(lines, sessionId, resultCount);
  cliDiagnostics = agyNativePolicyDiagnostics(turn, cliDiagnostics, debugRef);
  yield {
    kind: 'complete',
    observed: {
      sessionId,
      turn,
      transportError,
      ...(cliDiagnostics ? { cliDiagnostics } : {}),
      ...(transportExit ? { transportExit } : {}),
      cancelledBeforeTerminal: signal?.aborted === true && !resultSeenBeforeCancellation,
    },
  };
}

/** Batch consumer for probes; the service consumes observations as they arrive. */
export async function readAgyNativeTurn(
  stream: AsyncIterable<unknown>,
  expected: ExpectedNativeInit,
  signal?: AbortSignal,
): Promise<AgyNativeObservedTurn> {
  for await (const observation of observeAgyNativeTurn(stream, expected, signal)) {
    if (observation.kind === 'complete') return observation.observed;
  }
  throw new Error('AGY native stream ended without a terminal observation');
}
