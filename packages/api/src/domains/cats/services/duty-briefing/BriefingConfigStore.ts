/**
 * F233 Phase A — BriefingConfigStore（值班简报 thread 绑定，本 Phase 唯一新存储）
 *
 * 单 key 全局 config：存值班简报投递目标 threadId。TTL=0 持久化（铁律 5 LL-048）。
 * 仿 ConciergeConfigStore 三件模式：port interface + Redis 实现 + Memory 实现（测试）。
 *
 * 状态机（spec Stateful Object Gate）：
 *  - unbound:  无 key（getBinding → null）
 *  - bound:    有 threadId（getBinding → {threadId}）
 *  - degraded: bound 但投递时 thread 不存在 —— 非持久状态，由 resolveBriefingTarget 投递时校验得出
 * 不变量：
 *  - INV-1: 至多一个 active binding（单 key 天然，setBinding 覆盖而非累加）
 *  - INV-2: binding 失效不静默吞简报（resolveBriefingTarget 显式返回 degraded，调用方走告警路径）
 *  - INV-3: 绑定不自动创建 thread（store 只写 config key，不持有 ThreadStore 依赖）
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

export const BRIEFING_BINDING_KEY = 'duty-briefing:binding';

export interface BriefingBinding {
  threadId: string;
}

export interface IBriefingConfigStore {
  /** 当前绑定；unbound → null */
  getBinding(): Promise<BriefingBinding | null>;
  /** 设置/覆盖绑定（INV-1 单 active）；不创建 thread（INV-3） */
  setBinding(threadId: string): Promise<void>;
  /** 解除绑定 */
  clearBinding(): Promise<void>;
}

export class RedisBriefingConfigStore implements IBriefingConfigStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async getBinding(): Promise<BriefingBinding | null> {
    const raw = await this.redis.get(BRIEFING_BINDING_KEY);
    return raw ? (JSON.parse(raw) as BriefingBinding) : null;
  }

  async setBinding(threadId: string): Promise<void> {
    // TTL=0 = 不设 EXPIRE = 持久化（铁律 5 LL-048）
    await this.redis.set(BRIEFING_BINDING_KEY, JSON.stringify({ threadId }));
  }

  async clearBinding(): Promise<void> {
    await this.redis.del(BRIEFING_BINDING_KEY);
  }
}

export class MemoryBriefingConfigStore implements IBriefingConfigStore {
  private binding: BriefingBinding | null = null;

  async getBinding(): Promise<BriefingBinding | null> {
    return this.binding ? { ...this.binding } : null;
  }

  async setBinding(threadId: string): Promise<void> {
    this.binding = { threadId };
  }

  async clearBinding(): Promise<void> {
    this.binding = null;
  }
}

// ---------------------------------------------------------------------------
// 投递目标解析（degraded 在此瞬时计算，不持久化——INV-2 不静默）
// ---------------------------------------------------------------------------

export type BriefingTargetStatus = 'unbound' | 'bound' | 'degraded';

export interface BriefingTarget {
  status: BriefingTargetStatus;
  threadId?: string;
}

/**
 * 解析投递目标 + binding 健康度。
 * - 无绑定           → unbound
 * - 绑定且 thread 在 → bound（正常投递）
 * - 绑定但 thread 删 → degraded（INV-2：调用方据此走降级——记 error + 简报头部"⚠️ 绑定失效"，不静默吞）
 *
 * threadExists 用 callback 注入（不直接依赖 ThreadStore，解耦 + 好测）。
 */
export async function resolveBriefingTarget(
  configStore: IBriefingConfigStore,
  threadExists: (threadId: string) => Promise<boolean> | boolean,
): Promise<BriefingTarget> {
  const binding = await configStore.getBinding();
  if (!binding) return { status: 'unbound' };
  const exists = await threadExists(binding.threadId);
  if (!exists) return { status: 'degraded', threadId: binding.threadId };
  return { status: 'bound', threadId: binding.threadId };
}
