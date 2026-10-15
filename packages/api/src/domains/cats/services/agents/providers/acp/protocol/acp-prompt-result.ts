import type { AcpPromptResult, AcpSessionUpdate, AcpStopReason } from '../types.js';

const STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];
export interface AcpPromptStreamOptions {
  timeoutMs?: number;
  idleWarningMs?: number;
  idleStallMs?: number;
  /** Full native receipt; retaining fields does not establish semantic authority. */
  onResult?: (result: AcpPromptResult) => void;
}
export function readAcpPromptResult(value: unknown): AcpPromptResult {
  if (
    !value ||
    typeof value !== 'object' ||
    !('stopReason' in value) ||
    typeof value.stopReason !== 'string' ||
    !STOP_REASONS.includes(value.stopReason)
  ) {
    throw new Error('ACP prompt response has missing or invalid stopReason');
  }
  return value as AcpPromptResult;
}
export class AcpPromptStoppedError extends Error {
  readonly nativeAcknowledged = true;
  constructor(readonly stopReason: Exclude<AcpStopReason, 'end_turn'>) {
    super(`ACP native prompt completed with stopReason=${stopReason}`);
    this.name = 'AcpPromptStoppedError';
  }
}
/** for-await discards returns; observe the native terminal before the service can retry. */
export async function* observeAcpPromptTerminal(
  stream: AsyncGenerator<AcpSessionUpdate, AcpStopReason | void>,
  onEvent: () => void,
  onStop: (reason: AcpStopReason | void) => void,
): AsyncGenerator<AcpSessionUpdate, AcpStopReason | void> {
  let completed = false;
  try {
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        completed = true;
        onStop(next.value);
        if (next.value && next.value !== 'end_turn') throw new AcpPromptStoppedError(next.value);
        return next.value;
      }
      onEvent();
      yield next.value;
    }
  } finally {
    if (!completed) await stream.return(undefined);
  }
}
