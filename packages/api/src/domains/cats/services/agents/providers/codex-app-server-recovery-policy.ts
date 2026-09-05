import type { CodexAppServerLifecycleSnapshot } from './CodexAppServerClient.js';
import type { CodexCapacityRecoveryCheckpoint } from './CodexCapacityRecoveryCheckpoint.js';

const MODEL_CAPACITY_ERROR = 'Selected model is at capacity. Please try a different model.';

export function canRetryBeforeTurn(
  lifecycle: CodexAppServerLifecycleSnapshot | null,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted) return false;
  if (!lifecycle) return true;
  if (lifecycle.interruptReason) return false;
  return !lifecycle.turnStartSent && !lifecycle.turnAccepted && !lifecycle.itemObserved;
}

export function canRetryModelCapacity(
  lifecycle: CodexAppServerLifecycleSnapshot | null,
  signal: AbortSignal | undefined,
  checkpoint: CodexCapacityRecoveryCheckpoint,
): boolean {
  if (signal?.aborted) return false;
  if (!lifecycle) return false;
  if (lifecycle.interruptReason) return false;
  if (!lifecycle.turnAccepted) return false;
  if (!checkpoint.hasExactAnchor()) return false;
  if (!lifecycle.toolSurfaceObserved) return true;
  return checkpoint.canResumeAfterTools();
}

function isModelCapacityMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const message = value.trim();
  return message === MODEL_CAPACITY_ERROR || message === `Error running remote compact task: ${MODEL_CAPACITY_ERROR}`;
}

export function isModelCapacityNotice(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const event = value as { type?: unknown; message?: unknown };
  return event.type === 'error' && isModelCapacityMessage(event.message);
}

export function isModelCapacityError(error: unknown): boolean {
  return error instanceof Error && isModelCapacityMessage(error.message);
}

export function isActiveWriterError(error: unknown): boolean {
  return error instanceof Error && /^thread \S+ already has an active writer$/.test(error.message.trim());
}

export function isModelCapacityTurnFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; error?: unknown };
  if (record.type !== 'turn.failed') return false;
  if (!record.error || typeof record.error !== 'object') return false;
  return isModelCapacityMessage((record.error as { message?: unknown }).message);
}
