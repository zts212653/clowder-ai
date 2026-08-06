/**
 * Known-Client Context Window Capabilities (#1208 Item 6)
 *
 * Documents what each ClientId CAN report for context window discovery.
 * Three orthogonal capability dimensions (Sol review: Antigravity push-back):
 *   - catalogAvailable:      can look up model in static catalog
 *   - reportsRuntimeWindow:  CLI/bridge emits contextWindowSize at runtime
 *   - reportsUsage:          bridge emits per-turn usage telemetry
 *
 * These are DISTINCT abilities: "can query catalog" ≠ "bridge reports window."
 * Antigravity can look up Claude models in catalog but the bridge itself
 * does NOT emit runtime window or usage data.
 *
 * Nine client types from ClientId:
 *   anthropic, openai, opencode, google, kimi, antigravity, catagent, acp, a2a
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface ClientContextCapability {
  /** Whether the model catalog is reliable for this client's model names. */
  readonly catalogAvailable: boolean;
  /** Whether this client's CLI/carrier emits contextWindowSize at runtime. */
  readonly reportsRuntimeWindow: boolean;
  /** Whether this client's CLI/carrier emits per-turn usage telemetry. */
  readonly reportsUsage: boolean;
  /** Brief reason for Hub display. */
  readonly reason: string;
}

// ─── Registry ────────────────────────────────────────────────────────

/**
 * Known context-window reporting capabilities per ClientId.
 * Authoritative: if a client is missing, assume fail-closed defaults.
 *
 * Fail-closed = all three booleans false:
 *   - resolver won't get an exact window
 *   - catalog might not have the model
 *   - manual cap is the only reliable path
 *   - lifecycle actions (handoff/seal) won't auto-trigger without actionable capacity
 */
export const CLIENT_CONTEXT_CAPABILITIES: Readonly<Record<string, ClientContextCapability>> = {
  // ── Clients that report window + usage at runtime ──
  anthropic: {
    catalogAvailable: true,
    reportsRuntimeWindow: true,
    reportsUsage: true,
    reason: 'Claude CLI reports exact window via modelUsage',
  },
  openai: {
    catalogAvailable: true,
    reportsRuntimeWindow: true,
    reportsUsage: true,
    reason: 'Codex reports via session context snapshot',
  },
  google: {
    catalogAvailable: true,
    reportsRuntimeWindow: true,
    reportsUsage: true,
    reason: 'Gemini CLI reports via stats.context_window',
  },
  kimi: {
    catalogAvailable: true,
    reportsRuntimeWindow: true,
    reportsUsage: true,
    reason: 'Kimi reports via stats.context_window',
  },

  // ── Clients with catalog but NO runtime reporting ──
  antigravity: {
    catalogAvailable: true,
    reportsRuntimeWindow: false,
    reportsUsage: false,
    reason: 'Antigravity bridge wraps Claude models (catalog available) but does not emit runtime window or usage',
  },
  opencode: {
    catalogAvailable: true,
    reportsRuntimeWindow: false,
    reportsUsage: true,
    reason: 'OpenCode CLI does not emit contextWindowSize; catalog or manual cap required',
  },
  catagent: {
    catalogAvailable: true,
    reportsRuntimeWindow: false,
    reportsUsage: true,
    reason: 'ACP SSE does not include context window; relies on model catalog',
  },

  // ── Unknown/opaque clients (fail-closed, manual cap needed) ──
  acp: {
    catalogAvailable: false,
    reportsRuntimeWindow: false,
    reportsUsage: false,
    reason: 'Generic ACP — unknown agent; manual cap strongly recommended',
  },
  a2a: {
    catalogAvailable: false,
    reportsRuntimeWindow: false,
    reportsUsage: false,
    reason: 'A2A protocol — context window not discoverable; manual cap required',
  },
};

// ─── Lookup ──────────────────────────────────────────────────────────

const FAIL_CLOSED: ClientContextCapability = {
  catalogAvailable: false,
  reportsRuntimeWindow: false,
  reportsUsage: false,
  reason: 'Unknown client — manual cap recommended',
};

/**
 * Get context capability for a client. Unknown clients fail closed.
 * Fail-closed default: no catalog, no runtime window, no usage.
 */
export function getClientCapability(clientId: string | undefined): ClientContextCapability {
  if (!clientId) {
    return { ...FAIL_CLOSED, reason: 'No client specified' };
  }
  return (
    CLIENT_CONTEXT_CAPABILITIES[clientId] ?? {
      ...FAIL_CLOSED,
      reason: `Unknown client "${clientId}" — manual cap recommended`,
    }
  );
}
