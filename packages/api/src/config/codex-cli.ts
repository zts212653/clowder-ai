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

/**
 * Prefer Codex's built-in OpenAI provider so upstream can select its current
 * transport behavior. `https` remains an operational escape hatch for
 * environments where the built-in websocket path repeatedly fails.
 */
export function getCodexOAuthTransport(env: NodeJS.ProcessEnv = process.env): CodexOAuthTransport {
  return parseEnum(env.CAT_CAFE_CODEX_OAUTH_TRANSPORT, CODEX_OAUTH_TRANSPORTS, DEFAULT_CODEX_OAUTH_TRANSPORT);
}
