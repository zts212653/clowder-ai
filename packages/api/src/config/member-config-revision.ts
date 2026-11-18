import type { CatCafeConfig } from '@cat-cafe/shared';
import { roleConfigurationRevision } from '@clowder-ai/agent-access/roles/write-role';
import { saveSpan } from '../utils/member-save-diagnostics.js';
import { readCatCatalogRaw } from './cat-catalog-store.js';

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

/** A member-scoped validator read from disk, never from a stale registry cache. */
export function memberConfigurationRevision(projectRoot: string, catId: string): string | undefined {
  const raw = readCatCatalogRaw(projectRoot, { persistMigrations: false });
  if (!raw) return undefined;
  return roleConfigurationRevision(JSON.parse(raw) as CatCafeConfig, catId);
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
