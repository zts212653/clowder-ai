import type { CatId } from '@cat-cafe/shared';
import { sanitizeCliStderr } from '../../../../../../utils/sanitize-cli-stderr.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AgyStreamJsonTurn } from '../agy-stream-json-parser.js';
import { asRecord } from './agy-native-stream-validation.js';
import { agyNativeToolIdentity, agyNativeToolResultContent } from './agy-native-tool-result.js';
import { AGY_NATIVE_MCP_TOOLS, AGY_NATIVE_TOOLS } from './agy-native-tools.js';
import type { AgyNativeObservedTurn } from './run/agy-native-stream.js';

export { type AgyNativeObservedTurn, observeAgyNativeTurn, readAgyNativeTurn } from './run/agy-native-stream.js';

const MISSING_FILE_ERROR_PREFIX =
  'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: ' +
  'invalid tool call error (invalid_args) failed to read file: stat ';

function projectToolMessages(catId: CatId, metadata: MessageMetadata, turn: AgyStreamJsonTurn): AgentMessage[] {
  return turn.toolCalls.flatMap((call) => {
    const toolUseId = `${metadata.sessionId}:${call.stepIndex}`;
    const identity = agyNativeToolIdentity(call.toolName, call.parameters);
    return [
      {
        type: 'tool_use' as const,
        catId,
        toolName: identity.toolName,
        toolUseId,
        toolInput: identity.toolInput,
        toolSource: identity.toolSource,
        metadata,
        timestamp: Date.now(),
      },
      {
        type: 'tool_result' as const,
        catId,
        toolName: identity.toolName,
        toolUseId,
        content: agyNativeToolResultContent(
          call.output,
          call.errorMessage,
          call.state === 'DONE' || call.state === 'ERROR',
        ),
        toolResultStatus: call.state === 'DONE' && call.errorMessage === null ? ('ok' as const) : ('error' as const),
        metadata,
        timestamp: Date.now(),
      },
    ];
  });
}

/** A missing file is a read observation, not evidence that another tool repaired a failure. */
function isMissingFileObservation(call: AgyStreamJsonTurn['toolCalls'][number]): boolean {
  if (call.toolName !== 'view_file' || call.errorMessage === null || call.output) return false;
  const path = call.parameters.AbsolutePath ?? call.parameters.TargetFile;
  if (typeof path !== 'string' || !path.trim()) return false;
  // Keep the legacy file-not-found result and the observed 1.2.14 stat failure exact.
  // This diagnostic label never changes tool or carrier success.
  return (
    call.errorMessage === 'File not found' ||
    call.errorMessage === `${MISSING_FILE_ERROR_PREFIX}${path}: no such file or directory`
  );
}

/** Keep tool evidence, usable output and carrier outcome distinct. */
export function projectAgyNativeTurn(
  catId: CatId,
  metadata: MessageMetadata,
  observed: AgyNativeObservedTurn,
  cancelled: boolean,
  declaredNativeTools: readonly string[] = [...AGY_NATIVE_TOOLS, ...AGY_NATIVE_MCP_TOOLS],
  compactionRequested = false,
): AgentMessage[] {
  const { turn, transportError } = observed;
  const retainedErrorEvidence = turn.sessionTurnCount > 1 || turn.recoveredErrorSteps.length > 0;
  const completedCompactionEvidence =
    compactionRequested &&
    typeof turn.completedCompactionStep === 'number' &&
    turn.deniedActions.length === 0 &&
    turn.unknownEvents.length === 0 &&
    !cancelled;
  // Official 1.3.5 also exits 3 after a completed /compact when result carries
  // a previous or recovered attempt's error. This is only for the proven checkpoint,
  // never ordinary work, timeout/signal, an incomplete step or a new error step.
  const retainedCompactionExit =
    completedCompactionEvidence &&
    turn.upstreamStatus === 'ERROR' &&
    retainedErrorEvidence &&
    observed.transportExit?.code === 3 &&
    observed.transportExit.signal === null;
  const transportFailed = Boolean(transportError) && !retainedCompactionExit;
  const completedCompaction = completedCompactionEvidence && !transportFailed;
  const retainedSessionError =
    turn.outcome === 'error' &&
    turn.upstreamStatus === 'ERROR' &&
    retainedErrorEvidence &&
    (typeof turn.completedResponseStep === 'number' || completedCompaction) &&
    turn.unknownEvents.length === 0 &&
    !transportFailed &&
    !cancelled;
  const outcome =
    retainedSessionError || (completedCompaction && turn.outcome === 'empty' && turn.upstreamStatus === 'SUCCESS')
      ? 'ok'
      : turn.outcome;
  const readObservations = turn.toolCalls.filter(isMissingFileObservation).map((call) => ({
    stepIndex: call.stepIndex,
    toolName: call.toolName,
    outcome: 'not_found' as const,
  }));
  metadata.sessionId = observed.sessionId;
  metadata.diagnostics = {
    ...metadata.diagnostics,
    agyNative: {
      ...asRecord(metadata.diagnostics?.agyNative),
      upstreamStatus: turn.upstreamStatus,
      outcome,
      ...(retainedSessionError
        ? {
            upstreamOutcome: turn.outcome,
            retainedSessionError: sanitizeCliStderr(turn.upstreamError ?? turn.diagnosis).slice(0, 2000),
            completedResponseStep: turn.completedResponseStep,
            recoveredErrorSteps: turn.recoveredErrorSteps,
            ...(retainedCompactionExit
              ? { retainedCompactionExit: observed.transportExit, upstreamTransportError: transportError }
              : {}),
          }
        : {}),
      // A terminal result confirms only observed tool completion, never effect deduplication.
      toolResultsConfirmed:
        turn.stepsComplete && turn.toolCalls.every((call) => call.state === 'DONE' && call.errorMessage === null),
      upstreamUnauthenticated:
        /\b401\b/.test(turn.upstreamError ?? '') && /\bUNAUTHENTICATED\b/.test(turn.upstreamError ?? ''),
      deniedActions: turn.deniedActions,
      sessionUsage: turn.usage,
      unknownEvents: turn.unknownEvents,
      ...(turn.unconfirmedStepIndices?.length ? { unconfirmedStepIndices: turn.unconfirmedStepIndices } : {}),
      ...(readObservations.length ? { readObservations } : {}),
    },
  };
  if (turn.turnUsage) {
    const inputTokens = turn.turnUsage.inputTokens + turn.turnUsage.cacheReadTokens;
    metadata.usage = {
      inputTokens,
      outputTokens: turn.turnUsage.outputTokens,
      totalTokens: inputTokens + turn.turnUsage.outputTokens,
      cacheReadTokens: turn.turnUsage.cacheReadTokens,
      ...(turn.lastTurnInputTokens !== null ? { lastTurnInputTokens: turn.lastTurnInputTokens } : {}),
    };
  }
  const messages: AgentMessage[] = [
    { type: 'session_init', catId, sessionId: observed.sessionId, metadata, timestamp: Date.now() },
    ...projectToolMessages(catId, metadata, turn),
  ];
  const incompleteTools = turn.toolCalls.filter((call) => call.state !== 'DONE' && call.state !== 'ERROR');
  if (incompleteTools.length) {
    messages.push({
      type: 'system_info',
      catId,
      timestamp: Date.now(),
      semanticEvent: {
        v: 1,
        id: `${observed.sessionId}:unconfirmed-tools`,
        kind: 'warning',
        occurredAt: Date.now(),
        provenance: { provider: 'google', carrier: 'native', nativeType: 'result' },
        category: 'warning',
        severity: 'warning',
        message: `Native tool results unconfirmed at turn end: ${incompleteTools.map((call) => call.toolName).join(', ')}`,
      },
    });
  }
  const tools = new Set(declaredNativeTools);
  if (turn.unconfirmedStepIndices?.length) {
    messages.push({
      type: 'system_info',
      catId,
      timestamp: Date.now(),
      semanticEvent: {
        v: 1,
        id: `${observed.sessionId}:unidentified-steps`,
        kind: 'warning',
        occurredAt: Date.now(),
        provenance: { provider: 'google', carrier: 'native', nativeType: 'step_update' },
        category: 'warning',
        severity: 'warning',
        message: `Native 步骤身份未确认（${turn.unconfirmedStepIndices.join(', ')}）；不据此确认工具结果或自动恢复。`,
      },
    });
  }
  const unexpectedTool = turn.toolCalls.find((call) => !tools.has(call.toolName));
  if (turn.finalText) {
    messages.push({ type: 'text', catId, content: turn.finalText, metadata, timestamp: Date.now() });
  }
  // A tool failure is an observation for the model, not a failed carrier turn.
  // Completion does not certify tool success. A retained session error is
  // normalized only with matching current DONE evidence and a clean transport.
  if ((outcome === 'ok' || outcome === 'unconfirmed') && !transportFailed && !cancelled && !unexpectedTool) {
    messages.push({ type: 'done', catId, metadata, timestamp: Date.now() });
    return messages;
  }
  const errorCode = cancelled
    ? 'AGY_CANCELLED'
    : turn.outcome === 'denied'
      ? 'AGY_PERMISSION_DENIED'
      : unexpectedTool
        ? 'AGY_UNEXPECTED_TOOL'
        : 'AGY_NATIVE_FAILED';
  if (!cancelled && observed.cliDiagnostics) metadata.cliDiagnostics = observed.cliDiagnostics;
  messages.push({
    type: 'error',
    catId,
    errorCode,
    error: cancelled
      ? 'AGY native turn was cancelled before its terminal result'
      : unexpectedTool
        ? `AGY emitted undeclared native tool ${unexpectedTool.toolName}`
        : errorCode === 'AGY_NATIVE_FAILED' && metadata.cliDiagnostics?.reasonCode
          ? metadata.cliDiagnostics.publicSummary
          : (transportError ?? turn.diagnosis),
    metadata,
    timestamp: Date.now(),
  });
  messages.push({ type: 'done', catId, errorCode, metadata, timestamp: Date.now() });
  return messages;
}
