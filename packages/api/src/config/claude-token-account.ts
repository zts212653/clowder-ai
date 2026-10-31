/** F320: token identity is private; session/config roots continue to belong to the host. */
import { createHash } from 'node:crypto';
import type { AccountConfig, CredentialEntry, ExecutionAccountSnapshot } from '@cat-cafe/shared';

interface ClaudeExecutionAccountInput {
  id: string;
  displayName?: string;
  authType: 'oauth' | 'api_key';
  claude?: AccountConfig['claude'];
  envVars?: Record<string, string>;
  apiKey?: string;
}

export const CLAUDE_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{8,4096}$/;
export function claudeTokenStatus(credential?: CredentialEntry): 'saved' | 'missing' | 'expired' {
  if (!credential?.accessToken || !CLAUDE_TOKEN_PATTERN.test(credential.accessToken)) return 'missing';
  return credential.expiresAt !== undefined && credential.expiresAt <= Date.now() ? 'expired' : 'saved';
}
export function claudeTokenEnvironment(credential?: CredentialEntry): Record<string, string> {
  if (!credential?.accessToken || claudeTokenStatus(credential) !== 'saved')
    throw new Error('claude_token_missing_or_expired');
  return { CLAUDE_CODE_OAUTH_TOKEN: credential.accessToken };
}
export function claudeExecutionAccountSnapshot(account: ClaudeExecutionAccountInput): ExecutionAccountSnapshot {
  return Object.freeze({
    accountRef: account.id,
    displayName: account.displayName ?? account.id,
    authType: account.authType,
    accountRevision: createHash('sha256').update(JSON.stringify(account)).digest('hex'),
    // auth status reports loggedIn even for fake tokens; no verified identity is manufactured.
  });
}
export const CLAUDE_TOKEN_AUTH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_OAUTH_TOKEN_REFRESH_URL',
] as const;
/** Apply after user env and mode routing, so alternate credentials cannot override the selected token. */
export function applyClaudeTokenAccountEnv(env: Record<string, string | null>, selected?: boolean): void {
  if (!selected) return;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token || !CLAUDE_TOKEN_PATTERN.test(token)) throw new Error('claude_token_missing_or_expired');
  for (const key of CLAUDE_TOKEN_AUTH_KEYS) env[key] = null;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
}

/** Remove the exact private launch token before raw events or public envelopes are retained. */
export function redactClaudeLaunchToken<T>(value: T, token?: string): T {
  if (!token || value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'string' ? entry.split(token).join('[TOKEN_REDACTED]') : entry,
    ),
  ) as T;
}
