import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexAccountIdentity, CodexManagedAccount } from '@cat-cafe/shared';
import { readCodexLaunchConfig } from './codex-launch-config.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length < 1024 ? value : undefined;
}
/** Read the official file-store identity. Never return or persist tokens, and never refresh credentials. */
export function readCodexAccountIdentity(home: string): CodexAccountIdentity | undefined {
  try {
    return codexIdentityFromAuth(readFileSync(join(home, 'auth.json'), 'utf8'));
  } catch {
    return undefined;
  }
}
/** Missing file is distinct from a file that cannot be read or parsed. Never refresh auth. */
export function inspectCodexLogin(home: string, cwd?: string) {
  try {
    if (cwd) {
      const store = readCodexLaunchConfig(home, cwd, [], { nativeHome: process.env.HOME }).cli_auth_credentials_store;
      if (store !== undefined && store !== 'file') return { status: 'unreadable' as const };
    }
    const identity = codexIdentityFromAuth(readFileSync(join(home, 'auth.json'), 'utf8'));
    return identity ? { status: 'ready' as const, identity } : { status: 'unreadable' as const };
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? ('not_logged_in' as const) : ('unreadable' as const),
    };
  }
}
export function codexIdentityFromAuth(raw: string): CodexAccountIdentity | undefined {
  try {
    if (raw.length > 262144) return undefined;
    const auth = record(JSON.parse(raw));
    if (auth.OPENAI_API_KEY || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) return undefined;
    const tokens = record(auth.tokens);
    const token = typeof tokens.id_token === 'string' && tokens.id_token.length < 262144 ? tokens.id_token : undefined;
    if (!token) return undefined;
    const claims = record(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
    const native = record(claims['https://api.openai.com/auth']);
    if (native.chatgpt_account_is_fedramp === true) return undefined;
    const userId = text(native.chatgpt_user_id) ?? text(native.user_id);
    const workspaceId = text(tokens.account_id) ?? text(native.chatgpt_account_id);
    if (!userId || !workspaceId) return undefined;
    if (native.chatgpt_account_id && native.chatgpt_account_id !== workspaceId) return undefined;
    const email = text(claims.email) ?? text(record(claims['https://api.openai.com/profile']).email);
    const planType = text(native.chatgpt_plan_type);
    return { userId, workspaceId, ...(email ? { email } : {}), ...(planType ? { planType } : {}) };
  } catch {
    return undefined;
  }
}
export function sameCodexIdentity(a: CodexAccountIdentity | undefined, b: CodexAccountIdentity | undefined): boolean {
  return !!a && !!b && a.userId === b.userId && a.workspaceId === b.workspaceId;
}
export function codexManagedStatus(
  account: CodexManagedAccount,
): 'not_prepared' | 'not_logged_in' | 'ready' | 'identity_changed' {
  if (!account.prepared) return 'not_prepared';
  if (!account.identity) return 'not_logged_in';
  return sameCodexIdentity(account.identity, readCodexAccountIdentity(account.credentialHome))
    ? 'ready'
    : 'identity_changed';
}
