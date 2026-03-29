/**
 * F136 Phase 4a — Startup hook: migration + conflict scan + invariant guard
 *
 * HC-3: Run one-time migration from provider-profiles → accounts + credentials.
 * HC-5: Scan all known project roots for accountRef conflicts.
 * LL-043: Startup invariant — legacy source present + accounts missing → hard error.
 *
 * Called once after the API server binds its port.
 */
import { type AccountConflict, detectAccountConflicts } from './account-conflict-guard.js';
import { readCatalogAccounts } from './catalog-accounts.js';
import {
  hasLegacyProviderProfiles,
  type MigrationResult,
  migrateProviderProfilesToAccounts,
} from './migrate-provider-profiles.js';

export interface AccountStartupResult {
  migration: MigrationResult;
  conflicts: AccountConflict[];
}

/**
 * Run migration + conflict detection + invariant check at startup.
 * HC-5: Throws on conflict — caller must NOT swallow the error.
 * LL-043: Throws if legacy source exists but accounts are missing after migration.
 */
export function accountStartupHook(projectRoot: string): AccountStartupResult {
  let migration: MigrationResult;
  try {
    migration = migrateProviderProfilesToAccounts(projectRoot);
  } catch (err) {
    // If legacy source exists and migration threw (e.g. corrupted catalog JSON),
    // wrap as LL-043 so index.ts propagates it as a hard error instead of best-effort.
    if (hasLegacyProviderProfiles()) {
      throw new Error(
        `F136 LL-043: migration failed while legacy provider-profiles.json exists. ` +
          `Catalog may be corrupted. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }

  const conflicts = detectAccountConflicts(projectRoot);

  // HC-5: Cross-project conflict is a hard error — refuse to start with mismatched credentials.
  if (conflicts.length > 0) {
    const details = conflicts.map((c) => `"${c.accountRef}": ${c.details} (${c.projects.join(' vs ')})`).join('; ');
    throw new Error(`F136 HC-5: account conflict detected at startup — ${details}`);
  }

  // LL-043: Startup invariant — legacy source present but accounts missing = migration failed silently.
  // This prevents the server from running with an empty accounts page when old data exists.
  if (hasLegacyProviderProfiles()) {
    let accounts: Record<string, unknown>;
    try {
      accounts = readCatalogAccounts(projectRoot);
    } catch (err) {
      // Catalog read failed (e.g. corrupted JSON) — same LL-043 treatment.
      throw new Error(
        `F136 LL-043: cannot read catalog accounts while legacy provider-profiles.json exists. ` +
          `Catalog may be corrupted. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (Object.keys(accounts).length === 0) {
      throw new Error(
        'F136 LL-043: legacy provider-profiles.json exists but catalog has no accounts after migration. ' +
          'Migration may have failed silently. Check migration logs and retry.',
      );
    }
  }

  return { migration, conflicts };
}
