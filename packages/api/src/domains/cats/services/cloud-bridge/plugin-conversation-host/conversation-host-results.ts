import {
  type CloudConversationAckResult,
  type CloudConversationAppendMessageResult,
  isCloudBridgeFailureDiagnosticV1,
  isCloudConversationAckResult,
  isCloudConversationAppendMessageResult,
} from '@clowder-ai/plugin-contract';

/**
 * F202 W2-3 h3b — reads what a package answered to appendMessage / ack, under the frozen contract
 * (h3 (a′)). The order is fixed:
 *
 * 1. The contract's full strict guard. What passes is taken as it is.
 * 2. Only a failure that carries a diagnostic: a copy with `diagnostic` removed and every other
 *    field kept as it was (extra fields included) must pass the same full guard.
 * 3. The original diagnostic then stays only if the contract's isCloudBridgeFailureDiagnosticV1
 *    accepts it on its own; otherwise it is dropped and the verified errorCode kept. (With today's
 *    contract a diagnostic it accepts already passed step 1; checking again here means the result
 *    never depends on the two guards agreeing.)
 *
 * Anything else is undefined, which the caller treats as an unknown effect: an answer outside the
 * contract is never normalised into a failure.
 */
function readFailureTolerantResult<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T | undefined {
  if (guard(value)) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if ((value as { status?: unknown }).status !== 'failed' || !Object.hasOwn(value, 'diagnostic')) return undefined;
  const { diagnostic, ...envelope } = value as Record<string, unknown>;
  if (!guard(envelope)) return undefined;
  return isCloudBridgeFailureDiagnosticV1(diagnostic) ? ({ ...envelope, diagnostic } as T) : envelope;
}

export function readAppendMessageResult(value: unknown): CloudConversationAppendMessageResult | undefined {
  return readFailureTolerantResult(value, isCloudConversationAppendMessageResult);
}

export function readAckResult(value: unknown): CloudConversationAckResult | undefined {
  return readFailureTolerantResult(value, isCloudConversationAckResult);
}
