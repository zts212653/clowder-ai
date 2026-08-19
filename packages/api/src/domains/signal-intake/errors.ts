export type SignalAdmissionErrorCode =
  | 'INVALID_SIGNAL'
  | 'AUTHORITY_MISMATCH'
  | 'PLUGIN_NOT_READY'
  | 'GRANT_MISSING'
  | 'STALE_GRANT'
  | 'RUNTIME_LEASE_MISSING'
  | 'RUNTIME_LEASE_EXPIRED'
  | 'ROUTE_UNAVAILABLE'
  | 'STALE_ROUTE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SOURCE_IDENTITY_CONFLICT';

export class SignalAdmissionError extends Error {
  constructor(
    readonly code: SignalAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignalAdmissionError';
  }
}

export type MeetingIntakeErrorCode =
  | 'INTAKE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'INVALID_CHOICES'
  | 'DESTINATION_UNAVAILABLE'
  | 'INVALID_TRANSITION'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_AUTH_REQUIRED'
  | 'SOURCE_DELETED'
  | 'EXECUTION_FAILED';

export class MeetingIntakeError extends Error {
  constructor(
    readonly code: MeetingIntakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MeetingIntakeError';
  }
}
