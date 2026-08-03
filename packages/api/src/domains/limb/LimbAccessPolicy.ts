/**
 * LimbAccessPolicy — F126 Phase B 三维权限检查
 *
 * catId × nodeId × capability → authLevel
 * 三级授权：free（直接通过）/ leased（需要租约）/ gated（需要co-creator审批）
 */

import type { LimbAccessEntry, LimbAuthLevel, LimbCapability } from '@cat-cafe/shared';
import type { SqliteLimbPersistence } from './SqliteLimbPersistence.js';

export class LimbAccessPolicy {
  private readonly policies = new Map<string, LimbAccessEntry>();
  private readonly persistence?: SqliteLimbPersistence;

  constructor(persistence?: SqliteLimbPersistence) {
    this.persistence = persistence;
  }

  /** Load persisted policies into memory (call after persistence.initialize()) */
  initialize(): void {
    if (!this.persistence) return;
    for (const e of this.persistence.loadAccessPolicies()) {
      this.policies.set(LimbAccessPolicy.key(e.catId, e.nodeId, e.capability), e);
    }
  }

  private static key(catId: string, nodeId: string, capability: string): string {
    return `${catId}:${nodeId}:${capability}`;
  }

  /** 设置权限条目（覆盖已有） */
  setPolicy(entry: LimbAccessEntry): void {
    this.policies.set(LimbAccessPolicy.key(entry.catId, entry.nodeId, entry.capability), entry);
    this.persistence?.upsertAccessPolicy(entry);
  }

  /** 检查显式策略（未配置返回 null） */
  check(catId: string, nodeId: string, capability: string): LimbAuthLevel | null {
    const entry = this.policies.get(LimbAccessPolicy.key(catId, nodeId, capability));
    return entry?.authLevel ?? null;
  }

  /** 获取生效的权限级别：显式策略优先，回退到能力自身的 authLevel */
  getEffectiveAuth(catId: string, nodeId: string, cap: LimbCapability): LimbAuthLevel {
    return this.check(catId, nodeId, cap.cap) ?? cap.authLevel;
  }
}
