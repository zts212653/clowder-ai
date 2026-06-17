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

/** Whitelist of known CLI failure reasons (Phase A AC-A4 + Phase G AC-G1). */
export type CliErrorReasonCode =
  | 'invalid_thinking_signature'
  | 'missing_rollout'
  | 'model_not_found'
  | 'auth_failed'
  | 'quota_exceeded'
  | 'network_error'
  | 'invalid_config'
  | 'spawn_failed'
  | 'context_window_exceeded'
  | 'tool_call_parse_failed'
  | 'server_overloaded'
  /** Phase G (clowder-ai#875): CLI exited cleanly with event stream that has events but
   *  no text events (e.g. OpenCode + DeepSeek producing only `step_start`). NOT an error
   *  per se but surfaced via cliDiagnostics so users get evidence instead of generic
   *  "completed without textual output" message. */
  | 'silent_completion';

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
  /** Sanitized + length-capped CC error excerpt. KD-1 white-list: only filled from a
   *  whitelisted safe source (see `excerptSource`). When reasonCode is known, source =
   *  'classifier'; when reasonCode is unknown but CC emitted a structured result error,
   *  source = 'cc_structured' (Phase D AC-D3). When source is undefined, the excerpt
   *  MUST NOT be rendered — frontend treats missing source as a malformed/persisted
   *  payload and fails closed (defense-in-depth alongside backend admission). */
  safeExcerpt?: string;
  /** F212 Phase D (P2 fix per cloud codex review on a429aada3): safe-source whitelist for
   *  `safeExcerpt`. 'classifier' = known reasonCode classifier hit; 'cc_structured' = CC
   *  result event with structured error message (AC-D3 unknown fallback). Frontend gates
   *  excerpt rendering on `KNOWN_EXCERPT_SOURCES.has(excerptSource)` — both protects
   *  malformed payloads (no source) AND fails closed when older clients see a future
   *  source value they don't recognize (e.g. a hypothetical 'pii_redacted'). */
  excerptSource?: 'classifier' | 'cc_structured' | 'unknown_raw';
  /** Debug correlation metadata — safe to expose */
  debugRef: {
    command: string;
    exitCode: number | null;
    signal: NodeJS.Signals | string | null;
    invocationId?: string;
    /**
     * Provider-owned, path-safe spawn context. Values must be finite enum/hash
     * tokens only: no raw cwd/HOME/prompt/env values.
     */
    homeMode?: 'process_home' | 'child_env_home' | 'agy_profile_home';
    spawnCwdMode?: 'cat_cafe_agy_cwd' | 'agy_profile_cwd';
    spawnCwdKey?: string;
    profileId?: string;
  };
}
