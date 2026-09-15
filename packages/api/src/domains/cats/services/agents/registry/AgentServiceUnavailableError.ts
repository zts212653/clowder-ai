/** Registration diagnostics are safe to display; never store spawn env or raw provider errors here. */
export interface AgentRegistrationFailure {
  readonly code: string;
  readonly message: string;
}

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
