/**
 * F257 V2/Phase B — fire-and-forget guard rejection reporting (MCP client layer).
 *
 * MCP-local fail-closed rejections never reach an API route; this channel
 * makes them visible to the harness ledger (spec AC-B1 dual-entry: API route
 * layer AND MCP client layer must both emit).
 *
 * Fail-open contract: reporting must NEVER affect the tool result the cat
 * sees — fire-and-forget, all errors swallowed, nothing awaited on the tool
 * path. The server side (POST /api/callbacks/guard-rejections) derives
 * catId/threadId/invocationId from the auth headers, so this module only
 * sends guard semantics.
 *
 * Zero imports from callback-tools (the caller passes apiUrl + auth headers)
 * to keep the dependency one-directional: callback-tools → this module.
 */

export interface GuardRejectionTransport {
  /** Callback API base url (CallbackConfig.apiUrl). */
  apiUrl: string;
  /** Auth headers from buildAuthHeaders(config). */
  headers: Record<string, string>;
}

export interface GuardRejectionReport {
  kind: 'http_schema_reject' | 'http_policy_reject';
  guardId: string;
  sourceTool: string;
  normalizedReason: string;
}

/** Fire-and-forget; never throws, never blocks the tool path. */
export function reportGuardRejection(transport: GuardRejectionTransport, report: GuardRejectionReport): void {
  try {
    void fetch(`${transport.apiUrl}/api/callbacks/guard-rejections`, {
      method: 'POST',
      headers: { ...transport.headers, 'content-type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => {
      /* fail-open — observation must not affect the business path */
    });
  } catch {
    /* fail-open — even synchronous fetch setup errors are swallowed */
  }
}
