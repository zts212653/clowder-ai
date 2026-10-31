import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionResponse,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
  RuntimeProviderInteractionRequest,
} from '@cat-cafe/shared';
import { redactRuntimeInteractionResponse } from '@cat-cafe/shared';
import { RuntimeInteractionError } from './RuntimeInteractionError.js';

export interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

export function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function providerTerminalFrom(
  request: RuntimeProviderInteractionRequest,
  response: Exclude<RuntimeInteractionResponse, { kind: 'selection' | 'text' }>,
  settledAt: number,
): RuntimeInteractionTerminal {
  if (response.kind === 'answers') {
    return {
      status: 'answered',
      reasonCode: 'answered',
      settledAt,
      response: redactRuntimeInteractionResponse(request, response),
    };
  }
  const decision =
    request.kind === 'question' ? undefined : request.decisions.find(({ id }) => id === response.decisionId);
  if (!decision) throw new RuntimeInteractionError('invalid_response', 'decision is not allowed');
  const status = decision.outcome === 'accept' ? 'answered' : decision.outcome === 'decline' ? 'declined' : 'cancelled';
  const reasonCode =
    decision.outcome === 'accept' ? 'answered' : decision.outcome === 'decline' ? 'user_rejected' : 'user_cancelled';
  return { status, reasonCode, settledAt, response: redactRuntimeInteractionResponse(request, response) };
}

export function sameProviderCard(
  left: RuntimeInteractionCardRef | undefined,
  right: RuntimeInteractionCardRef,
): boolean {
  return Boolean(
    left &&
      left.threadId === right.threadId &&
      left.messageId === right.messageId &&
      left.blockId === right.blockId &&
      (!left.blockDigest || left.blockDigest === right.blockDigest),
  );
}

export function providerInteractionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runtimeInteractionAbortReason(signal: AbortSignal | undefined): RuntimeInteractionTerminalReasonCode {
  return signal?.reason === 'provider_cancelled' ? 'provider_cancelled' : 'transport_lost';
}

export function throwIfRuntimeInteractionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error(runtimeInteractionAbortReason(signal));
}
