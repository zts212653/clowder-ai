/** Registration diagnostics are safe to display; never store spawn env or raw provider errors here. */
export interface AgentRegistrationFailure {
  readonly code: string;
  readonly message: string;
}

/** Only owned configuration conflicts are eligible for admission reparse, before any model turn. */
export class ExecutionAdmissionConflict extends Error {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** The constructed service source must be rebuilt; ordinary capture races only need a fresh pin. */
export class StaleServiceSourceConflict extends ExecutionAdmissionConflict {}

export class AgentServiceUnavailableError extends Error {
  readonly reason: AgentRegistrationFailure;

  constructor(
    readonly catId: string,
    reason: AgentRegistrationFailure,
  ) {
    super(`AgentService unavailable for cat "${catId}" (${reason.code}): ${reason.message}`);
    this.name = 'AgentServiceUnavailableError';
    // Error serializers may tag nested message-bearing objects; keep the frozen registry snapshot separate.
    this.reason = { ...reason };
  }
}

export function terminalExecutionBindingFailure(error: unknown) {
  if (error instanceof ExecutionAdmissionConflict && !error.retryable) return 'execution_binding_conflict';
  if (error instanceof AgentServiceUnavailableError && !isRetryableAgentRegistration(error.reason))
    return 'execution_binding_unavailable';
}

/** An unpopulated registry or an unready bootstrap can recover on a later attempt. */
export function isRetryableAgentRegistration(reason: AgentRegistrationFailure) {
  return reason.code === 'not-registered' || reason.code === 'ACP_BOOTSTRAP_UNAVAILABLE';
}
