import type { NativeSessionBinding } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

/** Invocation-local continuation; Session and F299 remain the durable owners. */
export interface NativeAuthContinuation {
  readonly binding: NativeSessionBinding;
  readonly sourceGenerationId: string;
}

export const NATIVE_AUTH_CONTINUATION_PROMPT = [
  'Continue the unfinished work in this same conversation after the authentication interruption.',
  'Use the existing conversation and recorded tool results; do not repeat the original user request or completed operations.',
  'Check the status of any running or background command before starting more work.',
  'If the outcome of an operation cannot be established, report that uncertainty and stop before repeating it.',
].join('\n');

/** A generic auth label or synthetic error tool_result cannot prove this boundary. */
export function isConfirmedNativeAuthFailure(message: AgentMessage): boolean {
  const diagnostics = message.metadata?.cliDiagnostics;
  const native = message.metadata?.diagnostics?.agyNative;
  if (!native || typeof native !== 'object' || Array.isArray(native)) return false;
  const observed = native as Record<string, unknown>;
  return (
    message.type === 'error' &&
    message.errorCode === 'AGY_NATIVE_FAILED' &&
    diagnostics?.reasonCode === 'auth_failed' &&
    diagnostics.debugRef.exitCode === 3 &&
    diagnostics.debugRef.signal === null &&
    observed.upstreamStatus === 'ERROR' &&
    observed.outcome === 'error' &&
    observed.toolResultsConfirmed === true &&
    observed.upstreamUnauthenticated === true &&
    Array.isArray(observed.deniedActions) &&
    observed.deniedActions.length === 0 &&
    Array.isArray(observed.unknownEvents) &&
    observed.unknownEvents.length === 0
  );
}
