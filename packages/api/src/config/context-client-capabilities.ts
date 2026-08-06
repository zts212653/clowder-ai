/**
 * Known-Client Context Window Capabilities (#1208 Item 6)
 *
 * Documents what each ClientId CAN report for context window discovery.
 * Used for:
 *   - fail-closed reasoning: if a client can't report, catalog/default must suffice
 *   - telemetry: detecting blind spots where handoff can't trigger
 *   - UI: showing capability reason in Session Strategy
 *
 * Nine client types from ClientId:
 *   anthropic, openai, opencode, google, kimi, antigravity, catagent, acp, a2a
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface ClientContextCapability {
  /** Whether this client's CLI/carrier ever emits contextWindowSize in usage. */
  readonly reportsWindow: boolean;
  /** Whether model catalog lookup is reliable for this client's model names. */
  readonly catalogReliable: boolean;
  /** Brief reason for Hub display. */
  readonly reason: string;
}

// ─── Registry ────────────────────────────────────────────────────────

/**
 * Known context-window reporting capabilities per ClientId.
 * Authoritative: if a client is missing, assume fail-closed defaults.
 *
 * Fail-closed = { reportsWindow: false, catalogReliable: false }:
 *   - resolver won't get an exact window
 *   - catalog might not have the model
 *   - manual cap is the only reliable path
 *   - lifecycle actions (handoff/seal) won't auto-trigger without actionable capacity
 */
export const CLIENT_CONTEXT_CAPABILITIES: Readonly<Record<string, ClientContextCapability>> = {
  // ── Clients that report window (exact source available) ──
  anthropic: {
    reportsWindow: true,
    catalogReliable: true,
    reason: 'Claude CLI reports exact window via modelUsage',
  },
  openai: {
    reportsWindow: true,
    catalogReliable: true,
    reason: 'Codex reports via session context snapshot',
  },
  google: {
    reportsWindow: true,
    catalogReliable: true,
    reason: 'Gemini CLI reports via stats.context_window',
  },
  kimi: {
    reportsWindow: true,
    catalogReliable: true,
    reason: 'Kimi reports via stats.context_window',
  },
  antigravity: {
    reportsWindow: true,
    catalogReliable: true,
    reason: 'Antigravity wraps Claude; inherits reporting',
  },

  // ── Clients that do NOT report window (catalog/manual only) ──
  opencode: {
    reportsWindow: false,
    catalogReliable: true,
    reason: 'OpenCode CLI does not emit contextWindowSize; catalog or manual cap required',
  },
  catagent: {
    reportsWindow: false,
    catalogReliable: true,
    reason: 'ACP SSE does not include context window; relies on model catalog',
  },

  // ── Unknown/opaque clients (fail-closed, manual cap needed) ──
  acp: {
    reportsWindow: false,
    catalogReliable: false,
    reason: 'Generic ACP — unknown agent; manual cap strongly recommended',
  },
  a2a: {
    reportsWindow: false,
    catalogReliable: false,
    reason: 'A2A protocol — context window not discoverable; manual cap required',
  },
};

// ─── Lookup ──────────────────────────────────────────────────────────

/**
 * Get context capability for a client. Unknown clients fail closed.
 * Fail-closed default: no window reporting, no reliable catalog.
 */
export function getClientCapability(clientId: string | undefined): ClientContextCapability {
  if (!clientId) {
    return { reportsWindow: false, catalogReliable: false, reason: 'No client specified' };
  }
  return (
    CLIENT_CONTEXT_CAPABILITIES[clientId] ?? {
      reportsWindow: false,
      catalogReliable: false,
      reason: `Unknown client "${clientId}" — manual cap recommended`,
    }
  );
}
