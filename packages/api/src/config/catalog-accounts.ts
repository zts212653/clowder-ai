/**
 * F136 Phase 4a — Catalog accounts read/write layer (HC-2)
 *
 * CRUD for the `accounts` section in cat-catalog.json.
 * cat-catalog.json is the single runtime write source.
 */
import type { AccountConfig, CatCafeConfigV2 } from '@cat-cafe/shared';
import { readCatCatalog, writeCatCatalog } from './cat-catalog-store.js';

export function readCatalogAccounts(projectRoot: string): Record<string, AccountConfig> {
  const catalog = readCatCatalog(projectRoot);
  if (!catalog || catalog.version !== 2) return {};
  return (catalog as CatCafeConfigV2).accounts ?? {};
}

export function writeCatalogAccount(projectRoot: string, ref: string, account: AccountConfig): void {
  const catalog = readCatCatalog(projectRoot);
  if (!catalog) {
    // Bootstrap a minimal v2 catalog if none exists (e.g. first account created via API)
    writeCatCatalog(projectRoot, {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {},
      accounts: { [ref]: account },
    } as unknown as CatCafeConfigV2);
    return;
  }
  const v2 = catalog as CatCafeConfigV2;
  const nextAccounts = { ...(v2.accounts ?? {}), [ref]: account };
  writeCatCatalog(projectRoot, { ...v2, accounts: nextAccounts });
}

export function deleteCatalogAccount(projectRoot: string, ref: string): void {
  const catalog = readCatCatalog(projectRoot);
  if (!catalog) return;
  const v2 = catalog as CatCafeConfigV2;
  const existing = v2.accounts ?? {};
  if (!(ref in existing)) return;
  const { [ref]: _removed, ...rest } = existing;
  writeCatCatalog(projectRoot, { ...v2, accounts: rest });
}
