/**
 * F296 B4a: a JSON-RPC *error response* from the Codex app-server.
 *
 * This exists so continuity classification never has to string-match its way to
 * "did the provider reject us, or did the pipe break?". A `thread/resume` that
 * comes back as a JSON-RPC error is a provider verdict and may be answered with
 * a fallback `thread/start` (→ `replaced`). A transport failure is *not* a
 * verdict: it must fail the invocation with no continuity claim at all.
 *
 * Gate 0 (2026-08-20, codex-cli 0.147.0) observed the stale-resume rejection as
 * a JSON-RPC error with message `no rollout found for thread id <uuid>`. We key
 * off the envelope shape, not that message.
 */
export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly method: string;
  /** Private, same-response evidence. Only a bounded safe projection may leave the provider. */
  readonly data?: unknown;

  constructor(input: { message: string; method: string; code?: number; data?: unknown }) {
    super(input.message);
    this.name = 'CodexAppServerRpcError';
    this.method = input.method;
    this.data = input.data;
    if (typeof input.code === 'number') this.code = input.code;
  }
}

export function isCodexAppServerRpcError(value: unknown): value is CodexAppServerRpcError {
  return value instanceof CodexAppServerRpcError;
}

/** Transport failure of one named request, distinct from a provider's JSON-RPC verdict. */
export class CodexAppServerRequestError extends Error {
  constructor(
    readonly method: string,
    readonly requestCause: unknown,
  ) {
    super(requestCause instanceof Error ? requestCause.message : String(requestCause), { cause: requestCause });
    this.name = 'CodexAppServerRequestError';
  }
}

/** Missing acknowledgement is a transport failure, never a provider rejection or replay permission. */
export class CodexAppServerTurnStartTimeoutError extends Error {
  constructor(requestId: number, timeoutMs: number) {
    super(
      `Codex app-server did not acknowledge turn/start RPC ${requestId} within ${timeoutMs} ms; acceptance is unknown`,
    );
    this.name = 'CodexAppServerTurnStartTimeoutError';
  }
}
