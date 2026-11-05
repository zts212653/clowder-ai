import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodexAccountIdentity } from '@cat-cafe/shared';
import { resolveCatCafeDataRoot } from '../utils/cli-process-ownership.js';
import type { RuntimeProviderProfile } from './account-resolver.js';
import { readCodexLaunchConfig } from './codex-launch-config.js';

export type CodexAccountAuthMode = 'oauth' | 'api_key' | 'auto';
export interface CodexAccountLaunchDescriptor {
  readonly accountRef: string;
  readonly accountOwnerRoot: string;
  readonly accountRevision: string;
  readonly authMode: CodexAccountAuthMode;
  readonly credentialHome: string;
  readonly stateRoot: string;
  readonly sqliteHome: string;
  readonly managed?: true;
  readonly identity?: CodexAccountIdentity;
}
/** Private API execution state is stable across probes, calls and reconnects, without OAuth files. */
export function resolveCodexApiExecutionHome(
  descriptor: CodexAccountLaunchDescriptor,
  baseUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const scope = {
    accountRevision: descriptor.accountRevision,
    baseUrl,
    cwd: codexCanonicalPath(cwd, cwd),
    scope: 'private',
  };
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return codexCanonicalPath(
    join(
      resolveCatCafeDataRoot(process.env.CAT_CAFE_DATA_DIR, env.HOME || homedir()),
      'codex-api-execution',
      key,
      '.codex',
    ),
    cwd,
  );
}
/** Canonicalize existing ancestors without creating directories or opening credentials. */
export function codexCanonicalPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('codex_account_path_invalid');
    if (dirname(absolute) === absolute) throw new Error('codex_account_path_invalid');
    return join(codexCanonicalPath(dirname(absolute), cwd), basename(absolute));
  }
}
/** Resolve from the existing account snapshot; displayName and rotated tokens are deliberately absent. */
export function resolveCodexAccountLaunch(
  account: RuntimeProviderProfile,
  input: { cwd?: string; env?: NodeJS.ProcessEnv; authMode?: CodexAccountAuthMode } = {},
): CodexAccountLaunchDescriptor {
  const cwd = resolve(input.cwd ?? process.cwd());
  const env = { ...(input.env ?? process.env), ...account.envVars };
  const credentialHome = codexCanonicalPath(env.CODEX_HOME?.trim() || join(env.HOME || homedir(), '.codex'), cwd);
  const config = readCodexLaunchConfig(credentialHome, cwd, [], { nativeHome: env.HOME });
  const sqliteHome = codexCanonicalPath(
    account.codex?.sqliteHome ??
      (typeof config.sqlite_home === 'string' ? config.sqlite_home : env.CODEX_SQLITE_HOME?.trim() || credentialHome),
    cwd,
  );
  const authMode = input.authMode ?? (account.syntheticNative ? 'auto' : account.authType);
  const identity = {
    accountRef: account.id,
    authMode,
    credentialHome,
    stateRoot: account.codex?.stateRoot ?? credentialHome,
    sqliteHome,
    ...(account.codex
      ? { managed: true as const, ...(account.codex.identity ? { identity: { ...account.codex.identity } } : {}) }
      : {}),
  };
  return Object.freeze({
    ...identity,
    // Provenance is not an auth revision: adding it must not relocate existing API execution homes.
    accountOwnerRoot: codexCanonicalPath(account.accountOwnerRoot ?? cwd, cwd),
    accountRevision: createHash('sha256')
      .update(
        JSON.stringify({
          ...identity,
          ...(identity.identity
            ? { identity: { userId: identity.identity.userId, workspaceId: identity.identity.workspaceId } }
            : {}),
        }),
      )
      .digest('hex'),
  });
}
