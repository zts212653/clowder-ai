/**
 * Codex CLI Runtime Config
 * Centralized parsing for Codex sandbox/approval settings.
 */

export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never'] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access';
export const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = 'on-request';

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
 * Whether to skip --model flag when invoking Codex CLI.
 * Codex CLI 0.111.0+ with ChatGPT account mode rejects any --model argument.
 * Set CAT_CODEX_SKIP_MODEL=1 to omit --model and use the CLI's default model.
 */
export function shouldSkipCodexModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAT_CODEX_SKIP_MODEL === '1' || env.CAT_CODEX_SKIP_MODEL === 'true';
}
