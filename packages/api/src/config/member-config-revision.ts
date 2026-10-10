import { createHash } from 'node:crypto';
import type { CatCafeConfig } from '@cat-cafe/shared';
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
  const cat = toAllCatConfigs(JSON.parse(raw) as CatCafeConfig)[catId];
  if (!cat) return undefined;
  return createHash('sha256').update(JSON.stringify(cat)).digest('hex');
}

export function updateMemberWithRevision(
  projectRoot: string,
  catId: string,
  expected: string | undefined,
  patch: RuntimeCatUpdate,
) {
  return withRuntimeCatMutationLock(projectRoot, () => {
    if (expected && memberConfigurationRevision(projectRoot, catId) !== expected)
      throw new MemberConfigurationConflict();
    return updateRuntimeCat(projectRoot, catId, patch);
  });
}
