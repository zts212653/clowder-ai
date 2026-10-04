export type CollectivePrivateWorkRefusalReason =
  | 'work_execution_not_current'
  | 'owner_admission_unavailable'
  | 'private_provider_unsupported'
  | 'private_policy_conflict';

/** A terminal disposition for this exact queued carrier, never a Task closure or a transport retry. */
export class CollectivePrivateWorkRefusalError extends Error {
  readonly code = 'collective_private_work_refused';
  constructor(
    readonly reason: CollectivePrivateWorkRefusalReason,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CollectivePrivateWorkRefusalError';
  }
}

/** Only called at the Host-owned private admission seam. Raw Service/transport failures are preserved. */
export function privateAdmissionRefusal(error: unknown): unknown {
  if (!(error instanceof Error) || !('code' in error)) return error;
  if (error.code === 'WORK_EXECUTION_NOT_CURRENT')
    return new CollectivePrivateWorkRefusalError('work_execution_not_current', error.message, error);
  if (error.code === 'OWNER_ADMISSION_UNAVAILABLE')
    return new CollectivePrivateWorkRefusalError('owner_admission_unavailable', error.message, error);
  return error;
}
