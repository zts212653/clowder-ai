/**
 * Codex CLI Runtime Config
 * Centralized parsing for Codex sandbox/approval settings.
 */

export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never'] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
export type CodexCarrierMode = 'exec_json' | 'app_server';
export const CODEX_OAUTH_TRANSPORTS = ['builtin', 'https'] as const;
export type CodexOAuthTransport = (typeof CODEX_OAUTH_TRANSPORTS)[number];

export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access';
export const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = 'on-request';
export const DEFAULT_CODEX_OAUTH_TRANSPORT: CodexOAuthTransport = 'builtin';

function parseEnum<T extends readonly string[]>(raw: string | undefined, valid: T, fallback: T[number]): T[number] {
  if (!raw) return fallback;
  const normalized = raw.trim();
  if (normalized.length === 0) return fallback;
  return (valid as readonly string[]).includes(normalized) ? (normalized as T[number]) : fallback;
}

export function getCodexSandboxMode(env: NodeJS.ProcessEnv = process.env): CodexSandboxMode {
  return parseEnum(env.CAT_CODEX_SANDBOX_MODE, CODEX_SANDBOX_MODES, DEFAULT_CODEX_SANDBOX_MODE);
}

export function getCodexApprovalPolicy(env: NodeJS.ProcessEnv = process.env): CodexApprovalPolicy {
  return parseEnum(env.CAT_CODEX_APPROVAL_POLICY, CODEX_APPROVAL_POLICIES, DEFAULT_CODEX_APPROVAL_POLICY);
}

/** F254 D2: app-server remains explicit opt-in until the parity matrix is green. */
export function getCodexCarrierMode(env: NodeJS.ProcessEnv = process.env): CodexCarrierMode {
  return env.CAT_CAFE_CODEX_CARRIER?.trim() === 'app_server' ? 'app_server' : 'exec_json';
}

export type CodexCarrierSource = 'per-cat' | 'env' | 'default';

export interface CodexCarrierTruth {
  effective: CodexCarrierMode;
  source: CodexCarrierSource;
}

/**
 * F254 D2: single resolver for "which carrier does this cat actually run on".
 * Precedence: per-cat cli.carrier override > CAT_CAFE_CODEX_CARRIER env > default
 * (exec_json). Used by the production agent-service assembly (index.ts) and by
 * GET /api/cats so the Hub displays the same truth the runtime executes.
 */
export function resolveCodexCarrierTruth(
  perCatCarrier: CodexCarrierMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
  configurationSource?: 'native_tool' | 'managed_account',
): CodexCarrierTruth {
  if (perCatCarrier !== undefined) return { effective: perCatCarrier, source: 'per-cat' };
  if (configurationSource === 'native_tool') return { effective: 'app_server', source: 'default' };
  const raw = env.CAT_CAFE_CODEX_CARRIER?.trim();
  if (raw) return { effective: raw === 'app_server' ? 'app_server' : 'exec_json', source: 'env' };
  return { effective: 'exec_json', source: 'default' };
}

/**
 * Prefer Codex's built-in OpenAI provider so upstream can select its current
 * transport behavior. `https` remains an operational escape hatch for
 * environments where the built-in websocket path repeatedly fails.
 */
export function getCodexOAuthTransport(env: NodeJS.ProcessEnv = process.env): CodexOAuthTransport {
  return parseEnum(env.CAT_CAFE_CODEX_OAUTH_TRANSPORT, CODEX_OAUTH_TRANSPORTS, DEFAULT_CODEX_OAUTH_TRANSPORT);
}

export const CODEX_SERVED_MODEL_OBSERVATIONS = ['on', 'off'] as const;
export type CodexServedModelObservation = (typeof CODEX_SERVED_MODEL_OBSERVATIONS)[number];
export const DEFAULT_CODEX_SERVED_MODEL_OBSERVATION: CodexServedModelObservation = 'on';

/**
 * F319: record which model the upstream actually answered with. `on` adds the
 * trace directives (websocket frames via tungstenite, HTTPS stream via the
 * SSE trace) for every session without a custom base URL — which credential
 * signs the request is Codex's own choice, not Clowder AI's auth label — and
 * leaves the transport as the operator configured it; `off` restores the
 * exact pre-F319 launch.
 */
export function getCodexServedModelObservation(env: NodeJS.ProcessEnv = process.env): CodexServedModelObservation {
  return parseEnum(
    env.CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION,
    CODEX_SERVED_MODEL_OBSERVATIONS,
    DEFAULT_CODEX_SERVED_MODEL_OBSERVATION,
  );
}
