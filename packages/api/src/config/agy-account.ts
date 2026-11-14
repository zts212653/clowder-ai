import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { resolveAccountWriteRoot } from './account-store-topology.js';

export const AGY_OAUTH_FILE = 'antigravity-oauth-token';
export type AgyLoginStatus = 'ready' | 'refreshable' | 'not_logged_in' | 'unreadable';

export function agyOAuthFile(home: string): string {
  return join(home, '.gemini', 'antigravity-cli', AGY_OAUTH_FILE);
}

/** Only new account-owned directories. Never import an existing profile or system keychain. */
export function prepareAgyAccount(projectRoot: string, accountRef: string): NonNullable<AccountConfig['agy']> {
  if (!/^agy-[a-f0-9-]{36}$/.test(accountRef)) throw new Error('agy_account_ref_invalid');
  const parent = join(resolveAccountWriteRoot(projectRoot), '.cat-cafe');
  const parentStat = lstatSync(parent, { throwIfNoEntry: false });
  if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink()))
    throw new Error('agy_account_directory_unsafe');
  mkdirSync(parent, { recursive: true });
  const base = join(parent, 'agy-accounts');
  const home = join(base, accountRef);
  for (const path of [base, home, join(home, '.gemini'), join(home, '.gemini', 'antigravity-cli')]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0))
      throw new Error('agy_account_directory_unsafe');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return { storage: 'cli_file', credentialHome: realpathSync(home) };
}

export function assertAgyCredentialHome(home: string): void {
  if (!isAbsolute(home) || resolve(home) === resolve(homedir())) throw new Error('agy_account_directory_unsafe');
  for (const path of [home, join(home, '.gemini'), join(home, '.gemini', 'antigravity-cli')]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('agy_account_directory_unsafe');
  }
}

/** Observes the official file only; expiry alone does not invalidate a refreshable login. */
export function inspectAgyLogin(home: string): AgyLoginStatus {
  try {
    assertAgyCredentialHome(home);
    const path = agyOAuthFile(home);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return 'not_logged_in';
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) return 'unreadable';
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      auth_method?: unknown;
      token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown };
    };
    if (
      parsed.auth_method !== 'consumer' ||
      typeof parsed.token?.access_token !== 'string' ||
      !parsed.token.access_token
    )
      return 'unreadable';
    const expiry = typeof parsed.token.expiry === 'string' ? Date.parse(parsed.token.expiry) : Number.NaN;
    if (!Number.isFinite(expiry)) return 'unreadable';
    if (expiry > Date.now()) return 'ready';
    return typeof parsed.token.refresh_token === 'string' && parsed.token.refresh_token
      ? 'refreshable'
      : 'not_logged_in';
  } catch {
    return 'unreadable';
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Official remote/SSH auth selects the CLI's file store. No OS keychain setup or token transport. */
export function agyLoginCommand(home: string): string | undefined {
  const command = resolveCliCommand('agy');
  if (!command) return undefined;
  return `pnpm --dir ${shellQuote(findMonorepoRoot())} agy:account:login --home ${shellQuote(home)}`;
}
