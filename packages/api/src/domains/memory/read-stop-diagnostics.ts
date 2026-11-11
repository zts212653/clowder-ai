type ControlledReadStopReason = 'deadline_exceeded' | 'read_cutoff' | 'read_closed';

const controlledReasons = new Set<ControlledReadStopReason>(['deadline_exceeded', 'read_cutoff', 'read_closed']);
const isControlledReason = (value: unknown): value is ControlledReadStopReason =>
  typeof value === 'string' && controlledReasons.has(value as ControlledReadStopReason);

export type ReadStopReason =
  | ControlledReadStopReason
  | 'source_work_budget'
  | 'caller_cancelled'
  | 'reader_rejected'
  | 'operation_rejected'
  | 'unknown';

const reasons = new Set<ReadStopReason>([
  ...controlledReasons,
  'source_work_budget',
  'caller_cancelled',
  'reader_rejected',
  'operation_rejected',
  'unknown',
]);
export const isReadStopReason = (value: unknown): value is ReadStopReason =>
  typeof value === 'string' && reasons.has(value as ReadStopReason);

/** Same budget error/re-export contract; its actual producer is the work-budget timer. */
export class ContextSourceTimeout extends Error {
  constructor() {
    super('context_source_timeout');
  }
}

/** Brand an existing controlled termination where it is produced, preserving DOMException name/message. */
export class ReadStopError extends DOMException {
  constructor(
    readonly stopReason: ControlledReadStopReason,
    message: string,
  ) {
    if (!isControlledReason(stopReason)) throw new TypeError('Invalid controlled read stop reason');
    super(message, stopReason === 'read_closed' ? 'AbortError' : 'TimeoutError');
  }
}

/** No error-name/message or wall-clock inference. Rejection describes the observed Promise, not SQLite cause. */
export function readStopReason(
  error: unknown,
  signal: AbortSignal | undefined,
  rejected: 'reader_rejected' | 'operation_rejected',
): ReadStopReason {
  try {
    if (error instanceof ContextSourceTimeout) return 'source_work_budget';
    if (error instanceof ReadStopError) {
      const reason = error.stopReason;
      return isControlledReason(reason) ? reason : 'unknown';
    }
    if (signal?.aborted) return error === signal.reason ? 'caller_cancelled' : 'unknown';
    return error instanceof Error ? rejected : 'unknown';
  } catch {
    return 'unknown';
  }
}
