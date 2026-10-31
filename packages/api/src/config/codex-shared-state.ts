import type { AccountConfig, CodexManagedAccount } from '@cat-cafe/shared';
import { accountToRuntimeProfile } from './account-resolver.js';
import { readAccountCatalogSnapshot } from './account-store-snapshot.js';
import {
  type CodexAccountLaunchDescriptor,
  codexCanonicalPath,
  resolveCodexAccountLaunch,
} from './codex-account-launch.js';

/** Durable layout claims reserve one owner, including an interrupted, unprepared creation.
 * Check prospective mutations and actual admission before writes/spawn; never migrate roots.
 */
export function assertCodexSharedStateRoots(
  projectRoot: string,
  input: {
    accounts?: Readonly<Record<string, AccountConfig>>;
    layout?: CodexManagedAccount;
    launch?: Pick<CodexAccountLaunchDescriptor, 'accountRef' | 'authMode' | 'managed' | 'stateRoot' | 'sqliteHome'>;
  } = {},
): void {
  const accounts = input.accounts ?? readAccountCatalogSnapshot(projectRoot);
  const layouts = Object.values(accounts).flatMap((account) => (account.codex ? [account.codex] : []));
  if (input.layout) layouts.push(input.layout);
  if (!layouts.length && !input.launch?.managed) return;
  const profile = accounts.codex
    ? accountToRuntimeProfile('codex', accounts.codex)
    : { id: 'codex', authType: 'oauth' as const, client: 'openai' as const };
  if (profile.authType !== 'oauth' || profile.client !== 'openai' || profile.codex)
    throw new Error('codex_default_account_unavailable');
  const source = resolveCodexAccountLaunch(profile, { cwd: projectRoot });
  const roots = layouts.map((layout) => ({ stateRoot: layout.stateRoot, sqliteHome: layout.sqliteHome }));
  if (
    input.launch &&
    (input.launch.managed || (input.launch.accountRef === 'codex' && input.launch.authMode === 'oauth'))
  )
    roots.push(input.launch);
  for (const root of roots)
    if (
      codexCanonicalPath(root.stateRoot, projectRoot) !== source.stateRoot ||
      codexCanonicalPath(root.sqliteHome, projectRoot) !== source.sqliteHome
    )
      throw new Error('codex_managed_state_roots_divergent');
}

/** Metadata updates/cancellation remain possible in a broken historical store.
 * Only a change of owner, roots or preparation needs prospective store validation.
 */
export function codexStateMutationChangesRoots(ref: string, before?: AccountConfig, after?: AccountConfig): boolean {
  const roots = (account?: AccountConfig) =>
    ref === 'codex'
      ? { authType: account?.authType, clientId: account?.clientId, envVars: account?.envVars, codex: account?.codex }
      : account?.codex
        ? {
            stateRoot: account.codex.stateRoot,
            sqliteHome: account.codex.sqliteHome,
            credentialHome: account.codex.credentialHome,
            prepared: account.codex.prepared,
          }
        : undefined;
  return JSON.stringify(roots(before)) !== JSON.stringify(roots(after));
}

/** A control/reconnect wire carries the accepted roots, independent of current member binding. */
export function assertCodexSharedStateCarrier(env: Record<string, string | null> | undefined): void {
  if (!env?.CODEX_CAT_STATE_ROOT || !env.CODEX_CAT_SHARED_SQLITE_HOME || !env.CODEX_CAT_ACCOUNT_REF) return;
  if (!env.CODEX_CAT_ACCOUNT_OWNER_ROOT) throw new Error('codex_account_owner_unavailable');
  assertCodexSharedStateRoots(env.CODEX_CAT_ACCOUNT_OWNER_ROOT, {
    launch: {
      accountRef: env.CODEX_CAT_ACCOUNT_REF,
      authMode: 'oauth',
      managed: env.CODEX_CAT_ACCOUNT_REF !== 'codex' ? true : undefined,
      stateRoot: env.CODEX_CAT_STATE_ROOT,
      sqliteHome: env.CODEX_CAT_SHARED_SQLITE_HOME,
    },
  });
}
