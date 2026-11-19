import { isDeepStrictEqual } from 'node:util';
import type { CliDiagnostics } from '@cat-cafe/shared';
import { isCliError, isCliTimeout, isLivenessWarning } from '../../../../../../../utils/cli-spawn.js';
import type { LivenessWarningEvent } from '../../../../../../../utils/ProcessLivenessProbe.js';
import type { AgentAccessAgyOutput } from '../../../../../../plugin/agent-access/agy.js';
import {
  type AgyStreamJsonEvent,
  type AgyStreamJsonTurn,
  agyTerminalPolicyRejected,
  parseAgyStreamJsonLine,
  summarizeAgyStreamJsonTurn,
} from '../../agy-stream-json-parser.js';
import { agyNativePolicyDiagnostics, missingAgyNativeInitError } from '../agy-native-errors.js';
import {
  asRecord,
  type ExpectedNativeInit,
  extractUnrecognizedInitTools,
  readAgyNativeEnvelope,
  verifiedInitSessionId,
  verifyAgyNativeResult,
} from '../agy-native-stream-validation.js';

export interface AgyNativeObservedTurn {
  readonly sessionId: string;
  readonly turn: AgyStreamJsonTurn;
  readonly transportError: string | null;
  readonly unrecognizedAdvertisedTools?: readonly string[];
  readonly cliDiagnostics?: CliDiagnostics;
  readonly transportExit?: { readonly code: number | null; readonly signal: string | null };
  readonly cancelledBeforeTerminal?: boolean;
}

export type AgyNativeStreamObservation =
  | { readonly kind: 'init'; readonly sessionId: string }
  | { readonly kind: 'step'; readonly event: Extract<AgyStreamJsonEvent, { kind: 'step' }> }
  | { readonly kind: 'liveness'; readonly warning: LivenessWarningEvent }
  | { readonly kind: 'result'; readonly observed: AgyNativeObservedTurn }
  | { readonly kind: 'turn_complete'; readonly observed: AgyNativeObservedTurn }
  | { readonly kind: 'complete'; readonly observed: AgyNativeObservedTurn };

const MAX_AGY_NATIVE_STREAM_CHARS = 8 * 1024 * 1024;
/** Treat init as a claim that must match the launch plan, never as proof that L0 reached the model. */
export async function* observeAgyNativeTurn(
  stream: AsyncIterable<unknown>,
  expected: ExpectedNativeInit,
  signal?: AbortSignal,
  multiTurn = false,
  adapter?: AgentAccessAgyOutput,
  credentials: readonly string[] = [],
): AsyncGenerator<AgyNativeStreamObservation> {
  const lines: string[] = [];
  let sessionId: string | null = null;
  let unrecognizedAdvertisedTools: readonly string[] = [];
  let transportError: string | null = null;
  let cliDiagnostics: CliDiagnostics | undefined;
  let transportExit: AgyNativeObservedTurn['transportExit'];
  let resultCount = 0;
  let resultSeenBeforeCancellation = false;
  let terminalPolicyRejected = false;
  let nativeStatus: string | null = null;
  let nativeHasResponse = false;
  let nativeHasTool = false;
  let nativeHasDenials = false;
  let streamChars = 0;
  const terminal = async (verifiedSessionId: string): Promise<AgyStreamJsonTurn> => {
    const turn = adapter ? await adapter.summarize(lines, terminalPolicyRejected) : summarizeAgyStreamJsonTurn(lines);
    if (turn.conversationId && turn.conversationId !== verifiedSessionId)
      throw new Error('AGY native terminal conversation ID disagrees with init');
    if (!adapter) return turn;
    if (
      turn.upstreamStatus !== nativeStatus ||
      (turn.outcome === 'ok' && (nativeStatus !== 'SUCCESS' || !nativeHasResponse)) ||
      (turn.outcome === 'unconfirmed' && !nativeHasResponse) ||
      (nativeStatus === null && turn.outcome !== 'incomplete' && turn.outcome !== 'protocol_error')
    )
      throw new Error('invalid_agy_native_terminal_evidence');
    if (
      nativeStatus !== 'SUCCESS' ||
      nativeHasTool ||
      nativeHasDenials ||
      turn.toolCalls.length ||
      turn.completedCompactionStep !== null
    ) {
      // These fields can admit native recovery or publication. Verify them against the original carrier evidence.
      const native = summarizeAgyStreamJsonTurn(lines, terminalPolicyRejected);
      const evidence = (result: AgyStreamJsonTurn) => ({
        outcome: result.outcome,
        toolCalls: result.toolCalls,
        deniedActions: result.deniedActions,
        completedResponseStep: result.completedResponseStep,
        completedCompactionStep: result.completedCompactionStep,
        recoveredErrorSteps: result.recoveredErrorSteps,
        stepsComplete: result.stepsComplete,
        sessionTurnCount: result.sessionTurnCount,
        unknownEvents: result.unknownEvents,
      });
      if (!isDeepStrictEqual(evidence(turn), evidence(native))) throw new Error('invalid_agy_native_terminal_evidence');
    }
    return turn;
  };
  const debugRef = (): CliDiagnostics['debugRef'] => ({
    command: expected.command ?? 'agy',
    signal: transportExit?.signal ?? null,
    ...(transportExit ? { exitCode: transportExit.code } : {}),
    ...(expected.invocationId ? { invocationId: expected.invocationId } : {}),
  });
  const input = adapter
    ? adapter.project(stream, credentials)
    : (async function* () {
        for await (const raw of stream) yield { raw, line: undefined, step: undefined };
      })();
  for await (const { raw, line: projectedLine, step } of input) {
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
      unrecognizedAdvertisedTools = extractUnrecognizedInitTools(record);
      yield { kind: 'init', sessionId };
    }
    const line = projectedLine ?? JSON.stringify(raw);
    const event = adapter ? step : parseAgyStreamJsonLine(line);
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
      if (!sessionId) throw new Error('AGY native next input has no verified session');
      // The next verified input closes the prior turn, including transport
      // evidence received after its upstream result. No sample is committed at SUCCESS alone.
      yield {
        kind: 'turn_complete',
        observed: {
          sessionId,
          turn: await terminal(sessionId),
          transportError,
          ...(unrecognizedAdvertisedTools.length ? { unrecognizedAdvertisedTools } : {}),
          ...(cliDiagnostics ? { cliDiagnostics } : {}),
          ...(transportExit ? { transportExit } : {}),
          cancelledBeforeTerminal: signal?.aborted === true && !resultSeenBeforeCancellation,
        },
      };
      lines.length = 0;
      resultCount = 0;
      terminalPolicyRejected = false;
      nativeStatus = null;
      nativeHasResponse = false;
      nativeHasTool = false;
      nativeHasDenials = false;
      resultSeenBeforeCancellation = false;
    }
    if (record.event === 'result') {
      if (sessionId) verifyAgyNativeResult(record, sessionId);
      const result = asRecord(record.result);
      const error = result?.error;
      nativeStatus = typeof result?.status === 'string' ? result.status : 'UNKNOWN';
      nativeHasResponse = typeof result?.response === 'string';
      nativeHasDenials = result?.denied_actions !== undefined;
      terminalPolicyRejected = typeof error === 'string' && agyTerminalPolicyRejected(error);
      resultCount++;
      if (!signal?.aborted) resultSeenBeforeCancellation = true;
    }
    if (record.event === 'step_update') {
      const rawStep = asRecord(record.step_update);
      nativeHasTool ||= Boolean(rawStep?.tool_name || rawStep?.step_type === 'tool' || rawStep?.step_type === 'finish');
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
      const turn = await terminal(sessionId);
      // An internal consumer can stop on this result, before process teardown.
      // Preserve stdout policy diagnostics without inventing exit/auth evidence.
      const resultDiagnostics = agyNativePolicyDiagnostics(turn, cliDiagnostics, debugRef());
      yield {
        kind: 'result',
        observed: {
          sessionId,
          turn,
          transportError,
          ...(unrecognizedAdvertisedTools.length ? { unrecognizedAdvertisedTools } : {}),
          ...(resultDiagnostics ? { cliDiagnostics: resultDiagnostics } : {}),
          cancelledBeforeTerminal: signal?.aborted === true && !resultSeenBeforeCancellation,
        },
      };
    }
  }
  if (!sessionId) throw missingAgyNativeInitError(lines, transportError, cliDiagnostics, debugRef());
  const turn = await terminal(sessionId);
  cliDiagnostics = agyNativePolicyDiagnostics(turn, cliDiagnostics, debugRef());
  yield {
    kind: 'complete',
    observed: {
      sessionId,
      turn,
      transportError,
      ...(unrecognizedAdvertisedTools.length ? { unrecognizedAdvertisedTools } : {}),
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
