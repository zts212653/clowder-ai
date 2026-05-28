/**
 * F212 — Cross-package CLI error diagnostics types.
 *
 * Phase A (api) produces `CliDiagnostics` payloads from `cli-spawn.ts`; Phase B (web)
 * consumes them in the folded error panel. Types live in shared so both packages
 * agree on shape without circular import via api utils.
 *
 * The classifier regex pool + sanitizer stay in api (Node-only deps); only the
 * data contract is shared.
 */

/** Whitelist of known CLI failure reasons (Phase A AC-A4). */
export type CliErrorReasonCode =
  | 'invalid_thinking_signature'
  | 'missing_rollout'
  | 'model_not_found'
  | 'auth_failed'
  | 'quota_exceeded'
  | 'network_error'
  | 'invalid_config'
  | 'spawn_failed'
  | 'context_window_exceeded';

/**
 * Structured CLI error payload (Phase A KD-1 white-list admission).
 *
 * Travels on:
 *  - api side: `AgentMessage.metadata.cliDiagnostics` (from cli-spawn `__cliError`/`__cliTimeout` events)
 *  - wire:    `BroadcastAgentMessage.metadata.cliDiagnostics` (SSE/socket spread, no special serialization)
 *  - web side: `ChatMessage.extra.cliDiagnostics` (after useAgentMessages error-path unpacking)
 */
export interface CliDiagnostics {
  /** Whitelist classification; undefined = unknown stderr / stream error */
  reasonCode?: CliErrorReasonCode;
  /** Always present; humanized title for error bubble (i18n: zh-CN in Phase A) */
  publicSummary: string;
  /** Always present; humanized hint for next action */
  publicHint: string;
  /** Only present when reasonCode !== undefined (AC-A5); sanitized + length-capped */
  safeExcerpt?: string;
  /** Debug correlation metadata — safe to expose */
  debugRef: {
    command: string;
    exitCode: number | null;
    signal: NodeJS.Signals | string | null;
    invocationId?: string;
  };
}
