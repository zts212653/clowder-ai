/**
 * LimbLeaseManager — F126 Phase B 租约调度
 *
 * 独占资源需要租约。同一能力同时只能被一只猫持有。
 * 租约有 TTL，过期自动释放（猫 crash 不永久锁四肢）。
 */

import { randomUUID } from 'node:crypto';
import type { LimbLease } from '@cat-cafe/shared';

export interface LeaseManagerOptions {
  defaultTtlMs: number;
}

const DEFAULT_OPTIONS: LeaseManagerOptions = {
  defaultTtlMs: 60_000, // 1 minute default
};

export class LimbLeaseManager {
  private readonly leases = new Map<string, LimbLease>();
  private readonly options: LeaseManagerOptions;

  constructor(options?: Partial<LeaseManagerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 获取租约（独占资源）。已被同一猫持有时幂等返回现有 lease。 */
  acquire(catId: string, nodeId: string, capability: string): LimbLease | null {
    // Check existing lease
    for (const lease of this.leases.values()) {
      if (lease.nodeId === nodeId && lease.capability === capability) {
        if (Date.now() >= lease.expiresAt) {
          // Expired, remove and continue
          this.leases.delete(lease.leaseId);
          break;
        }
        if (lease.catId === catId) {
          return lease; // Idempotent: same cat already holds it
        }
        return null; // Another cat holds it
      }
    }

    const now = Date.now();
    const lease: LimbLease = {
      leaseId: randomUUID(),
      nodeId,
      capability,
      catId,
      acquiredAt: now,
      expiresAt: now + this.options.defaultTtlMs,
      renewCount: 0,
    };

    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  /** 释放租约 */
  release(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  /** 续期 */
  renew(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    lease.expiresAt = Date.now() + this.options.defaultTtlMs;
    lease.renewCount++;
    return true;
  }

  /** 检查是否有活跃（未过期）租约 */
  isLeased(nodeId: string, capability: string): LimbLease | null {
    for (const lease of this.leases.values()) {
      if (lease.nodeId === nodeId && lease.capability === capability && Date.now() < lease.expiresAt) {
        return lease;
      }
    }
    return null;
  }

  /** 清理所有过期租约，返回已清理的 leaseId 列表 */
  expireAll(): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, lease] of this.leases) {
      if (now >= lease.expiresAt) {
        expired.push(id);
        this.leases.delete(id);
      }
    }
    return expired;
  }

  /** 按 catId 释放所有租约（猫 crash 时调用） */
  releaseAllByCat(catId: string): string[] {
    const released: string[] = [];
    for (const [id, lease] of this.leases) {
      if (lease.catId === catId) {
        released.push(id);
        this.leases.delete(id);
      }
    }
    return released;
  }

  get size(): number {
    return this.leases.size;
  }
}
