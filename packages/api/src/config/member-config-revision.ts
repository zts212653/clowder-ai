import { createHash } from 'node:crypto';
import type { CatCafeConfig } from '@cat-cafe/shared';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { readCatCatalogRaw } from './cat-catalog-store.js';
import { toAllCatConfigs } from './cat-config-loader.js';
import { type RuntimeCatUpdate, updateRuntimeCat, withRuntimeCatMutationLock } from './runtime-cat-catalog.js';

export class MemberConfigurationConflict extends Error {
  readonly statusCode = 409;
  constructor() {
    super('成员已在其他页面修改。草稿已保留，请重新读取后核对再保存。');
  }
}

export class MemberConfigurationRevisionRequired extends Error {
  readonly statusCode = 428;
  constructor() {
    super('缺少成员保存版本，请重新读取成员配置后再操作。');
  }
}

/** All save revisions in a member list come from one fresh read of the authored catalog. */
export function readMemberConfigurationRevisions(projectRoot: string): (catId: string) => string | undefined {
  const raw = readCatCatalogRaw(projectRoot, { persistMigrations: false });
  if (!raw) return () => undefined;
  const config = JSON.parse(raw) as CatCafeConfig;
  const cats = toAllCatConfigs(config);
  return (catId) => {
    const cat = cats[catId];
    if (!cat) return undefined;
    // Public projection omits tombstones. The authored overrides must also invalidate an older editor.
    const variant = config.breeds.flatMap((breed) =>
      breed.variants.filter((entry) => (entry.catId ?? breed.catId) === catId),
    )[0];
    const roster = config.version === 2 ? config.roster[catId] : undefined;
    return createHash('sha256').update(JSON.stringify({ cat, variant, roster })).digest('hex');
  };
}

/** A write validates the selected member against the disk while holding the mutation lock. */
export function memberConfigurationRevision(projectRoot: string, catId: string): string | undefined {
  return readMemberConfigurationRevisions(projectRoot)(catId);
}

/** The caller holds the existing catalog mutation lock through its complete mutation. */
export function assertMemberConfigurationRevision(projectRoot: string, catId: string, expected: string | undefined) {
  if (expected === undefined) throw new MemberConfigurationRevisionRequired();
  if (saveSpan('catalog.revision', () => memberConfigurationRevision(projectRoot, catId)) !== expected)
    throw new MemberConfigurationConflict();
}

export function updateMemberWithRevision(
  projectRoot: string,
  catId: string,
  expected: string | undefined,
  patch: RuntimeCatUpdate,
) {
  return withRuntimeCatMutationLock(projectRoot, () => {
    assertMemberConfigurationRevision(projectRoot, catId, expected);
    return saveSpan('catalog.persist', () => updateRuntimeCat(projectRoot, catId, patch));
  });
}
