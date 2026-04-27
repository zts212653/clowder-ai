/**
 * F174 Phase E — DegradePolicy framework for write-class callback tools.
 *
 * AC-E1: framework so existing create_rich_block Route B can be expressed
 *        declaratively, with same behavior.
 * AC-E2: every write-class callback tool declares an explicit policy
 *        (`none` is allowed; explicitness > silent default).
 * AC-E3: degradation only fires on 401 with degradable reason (expired /
 *        unknown_invocation). 5xx and other transient errors stay with
 *        the callback-retry layer.
 * AC-E4: successful fallback marks its JSON payload with DEGRADED:true so
 *        callers / dashboards can detect fallback mode.
 * AC-E6: stale_invocation is NOT degradable — degrading would re-create
 *        state on a superseded invocation. Surface the structured reason.
 */

import type { CallbackAuthFailureReason } from '@cat-cafe/shared';
import { CALLBACK_AUTH_FAILURE_REASONS, isCallbackAuthFailureReason } from '@cat-cafe/shared';
import type { ToolResult } from './file-tools.js';

const KNOWN_REASONS: ReadonlySet<CallbackAuthFailureReason> = new Set(CALLBACK_AUTH_FAILURE_REASONS);

/**
 * Degradable reasons: token has stopped working through expiry/registry loss.
 * Distinct from `invalid_token` (likely client bug) and `stale_invocation`
 * (succeeded but superseded — fallback would re-create stale state).
 * Mirrors the set previously hardcoded in callback-tools.ts.
 */
const DEGRADABLE_AUTH_REASONS: ReadonlySet<CallbackAuthFailureReason> = new Set(['expired', 'unknown_invocation']);

function parseAuthFailureReason(errorText: string): CallbackAuthFailureReason | undefined {
  const match = errorText.match(/reason\s*[:=]\s*([a-z_]+)/i);
  const reason = match?.[1];
  if (reason && isCallbackAuthFailureReason(reason) && KNOWN_REASONS.has(reason)) {
    return reason;
  }
  return undefined;
}

export type DegradePolicy =
  | { kind: 'none' }
  | { kind: 'custom'; degrade: (originalError: ToolResult) => Promise<ToolResult> };

export interface WithDegradationOptions {
  /** Tool name for telemetry / debugging. */
  toolName: string;
  /** Primary call (e.g., callbackPost). */
  primary: () => Promise<ToolResult>;
  /** Per-tool degrade policy (declared by each write-class tool). */
  policy: DegradePolicy;
}

/**
 * Wrap a primary callback call with degradation policy.
 *
 * Decision tree:
 *   primary success                            → return as-is
 *   primary fail, non-auth (5xx etc.)          → return as-is (callback-retry layer's domain)
 *   primary fail, auth but non-degradable      → return as-is (invalid_token, stale_invocation)
 *   primary fail, degradable (expired/unknown) →
 *     policy.kind = 'none'   → return original (caller surfaces 401)
 *     policy.kind = 'custom' → run degrade, mark DEGRADED:true on success
 */
export async function withDegradation(opts: WithDegradationOptions): Promise<ToolResult> {
  const result = await opts.primary();
  if (!result.isError) return result;

  const errorText = result.content[0]?.type === 'text' ? result.content[0].text : '';
  const reason = parseAuthFailureReason(errorText);
  if (reason === undefined) return result; // non-auth failure — not our domain
  if (!DEGRADABLE_AUTH_REASONS.has(reason)) return result; // invalid_token / stale_invocation surface as-is

  if (opts.policy.kind === 'none') {
    return appendNoFallbackHint(result, opts.toolName, reason);
  }

  const fallback = await opts.policy.degrade(result);
  if (fallback.isError) return fallback;
  return markDegraded(fallback);
}

/**
 * For kind:'none' tools, surface that the failure is auth-degradable but
 * the tool currently has no fallback path. Lets cats / users see the
 * structured reason explicitly without scanning the original message.
 */
function appendNoFallbackHint(result: ToolResult, toolName: string, reason: CallbackAuthFailureReason): ToolResult {
  const block = result.content[0];
  if (!block || block.type !== 'text') return result;
  const hint = `\n\n[degrade] tool=${toolName} reason=${reason} no fallback available — auth must be restored before retry`;
  return {
    ...result,
    content: [{ type: 'text', text: block.text + hint }],
  };
}

/**
 * Mark a successful fallback ToolResult with DEGRADED:true so callers can
 * detect fallback mode. Mutates the JSON text payload if it parses; if not
 * JSON, wraps it in a small envelope.
 */
function markDegraded(result: ToolResult): ToolResult {
  const block = result.content[0];
  if (!block || block.type !== 'text') return result;
  try {
    const parsed = JSON.parse(block.text);
    if (parsed && typeof parsed === 'object') {
      const tagged = { ...parsed, DEGRADED: true };
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify(tagged) }],
      };
    }
  } catch {
    // not JSON — wrap
    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify({ DEGRADED: true, payload: block.text }) }],
    };
  }
  return result;
}
