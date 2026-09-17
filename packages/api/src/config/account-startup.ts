/**
 * clowder-ai#340 — Account startup hook (fail-fast contract)
 *
 * Triggers migration, verifies accounts + credentials are readable,
 * and enforces LL-043: legacy source present + no accounts = hard error.
 */
import { inspectAccountCatalog, type UnavailableAccount } from './account-store-snapshot.js';
import { hasLegacyProviderProfiles, migrateCatalogAccounts } from './catalog-accounts.js';
import { assertCredentialsReadable } from './credentials.js';

export interface AccountStartupResult {
  accountCount: number;
  unavailableAccounts: UnavailableAccount[];
}

/**
 * Startup check — trigger migration and verify system health.
 * Throws on: migration conflict, corrupt accounts/credentials, LL-043 invariant.
 */
export function accountStartupHook(projectRoot: string): AccountStartupResult {
  // Preserve the credential-specific startup diagnostic before the combined snapshot read.
  try {
    assertCredentialsReadable(projectRoot);
  } catch (err) {
    throw new Error(`F136 startup: credentials read failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  // Migration is explicit at startup; ordinary readers never trigger it.
  let catalog: ReturnType<typeof inspectAccountCatalog>;
  try {
    migrateCatalogAccounts(projectRoot);
    catalog = inspectAccountCatalog(projectRoot);
  } catch (err) {
    // Wrap with context if legacy source exists (LL-043: migration failed)
    if (hasLegacyProviderProfiles(projectRoot)) {
      throw new Error(
        `F136 LL-043: account read/migration failed while legacy provider-profiles.json exists. ` +
          `Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }

  // LL-043: Legacy source present but no accounts after migration = silent failure
  if (
    hasLegacyProviderProfiles(projectRoot) &&
    Object.keys(catalog.entries).length === 0 &&
    catalog.unavailableAccounts.length === 0
  ) {
    throw new Error(
      'F136 LL-043: legacy provider-profiles.json exists but no accounts after migration. ' +
        'Migration may have failed silently. Check migration logs.',
    );
  }

  return { accountCount: Object.keys(catalog.entries).length, unavailableAccounts: catalog.unavailableAccounts };
}
