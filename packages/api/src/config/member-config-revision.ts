import { createHash } from 'node:crypto';
import type { CatCafeConfig } from '@cat-cafe/shared';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { readCatCatalogRaw } from './cat-catalog-store.js';
import { toAllCatConfigs } from './cat-config-loader.js';
import { type RuntimeCatUpdate, updateRuntimeCat, withRuntimeCatMutationLock } from './runtime-cat-catalog.js';

export class MemberConfigurationConflict extends Error {
  constructor() {
    super('成员已在其他页面修改。草稿已保留，请重新读取后核对再保存。');
  }
}

/** A member-scoped validator read from disk, never from a stale registry cache. */
export function memberConfigurationRevision(projectRoot: string, catId: string): string | undefined {
  const raw = readCatCatalogRaw(projectRoot, { persistMigrations: false });
  if (!raw) return undefined;
  const config = JSON.parse(raw) as CatCafeConfig;
  const cat = toAllCatConfigs(config)[catId];
  if (!cat) return undefined;
  // Public projection omits tombstones. The member's authored overrides must also invalidate an older editor.
  const variant = config.breeds.flatMap((breed) =>
    breed.variants.filter((entry) => (entry.catId ?? breed.catId) === catId),
  )[0];
  return createHash('sha256').update(JSON.stringify({ cat, variant })).digest('hex');
}

export function updateMemberWithRevision(
  projectRoot: string,
  catId: string,
  expected: string | undefined,
  patch: RuntimeCatUpdate,
) {
  return withRuntimeCatMutationLock(projectRoot, () => {
    if (expected && saveSpan('catalog.revision', () => memberConfigurationRevision(projectRoot, catId)) !== expected)
      throw new MemberConfigurationConflict();
    return saveSpan('catalog.persist', () => updateRuntimeCat(projectRoot, catId, patch));
  });
}
