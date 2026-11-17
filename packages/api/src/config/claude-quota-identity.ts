import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { builtinAccountFamilyForRef } from '@cat-cafe/shared';

interface ClaudeQuotaAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  claude?: { readonly kind: 'long_lived_token' };
  baseUrl?: string;
  envVars?: Readonly<Record<string, string>>;
}
export const claudeCredentialFingerprint = (token: string) => createHash('sha256').update(token).digest('hex');
export const hasClaudeQuotaAuthOverride = (env: Readonly<Record<string, unknown>> | undefined) =>
  Object.keys(env ?? {}).some((key) =>
    /^(CLAUDE_CODE_(OAUTH_TOKEN(?:_FILE_DESCRIPTOR|_REFRESH_URL)?|API_KEY_FILE_DESCRIPTOR|PROVIDER_MANAGED_BY_HOST|HOST_AUTH_ENV_VAR|USE_(?:BEDROCK|VERTEX|FOUNDRY))|ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|UNIX_SOCKET|PROFILE))$/.test(
      key,
    ),
  );

/** Mirrors CLI 2.1.325's native secure-storage name. No network or credential mutation. */
function nativeClaudeToken(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const home =
    secure !== undefined
      ? secure || join(homedir(), '.claude')
      : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try {
    let raw: string;
    if (process.platform === 'darwin') {
      const custom = secure !== undefined ? !!secure : !!process.env.CLAUDE_CONFIG_DIR;
      const suffix = custom ? `-${claudeCredentialFingerprint(home.normalize('NFC')).slice(0, 8)}` : '';
      const user = process.env.USER || userInfo().username;
      if (!/^[A-Za-z0-9._-]+$/.test(user)) return undefined;
      raw = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-a', user, '-w', '-s', `Claude Code-credentials${suffix}`],
        {
          encoding: 'utf8',
          timeout: 1500,
          maxBuffer: 262144,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } else raw = readFileSync(join(home, '.credentials.json'), 'utf8');
    if (raw.length > 262144) return undefined;
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : undefined;
  } catch {
    // Never attach exec errors: they may contain credential stdout/stderr.
    return undefined;
  }
}

export function claudeQuotaCredentialVersion(account: ClaudeQuotaAccount): string | undefined {
  if (account.authType !== 'oauth' || account.baseUrl) return undefined;
  if (account.claude) {
    const token = account.envVars?.CLAUDE_CODE_OAUTH_TOKEN;
    return token ? claudeCredentialFingerprint(token) : undefined;
  }
  if (builtinAccountFamilyForRef(account.id) !== 'anthropic' || Object.keys(account.envVars ?? {}).length)
    return undefined;
  // Alternate native token transports cannot be joined safely to the OS store.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR || process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)
    return undefined;
  const token = nativeClaudeToken();
  return token ? claudeCredentialFingerprint(token) : undefined;
}
