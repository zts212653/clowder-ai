/**
 * LimbRegistry — F126 四肢节点注册表
 *
 * 管理四肢节点的注册/注销/查询/调用。内存中的 live registry，
 * 与 capabilities.json（静态配置真相源）职责分离。
 *
 * Phase B: invoke 升级为 pipeline — policy check → lease → action log → execute。
 */

import type { ILimbNode, LimbAuthLevel, LimbInvokeResult, LimbNodeRecord, LimbNodeStatus } from '@cat-cafe/shared';
import type { LimbAccessPolicy } from './LimbAccessPolicy.js';
import type { LimbActionLog } from './LimbActionLog.js';
import type { LimbLeaseManager } from './LimbLeaseManager.js';

interface RegistryEntry {
  node: ILimbNode;
  record: LimbNodeRecord;
}

export interface LimbRegistryDeps {
  accessPolicy?: LimbAccessPolicy;
  leaseManager?: LimbLeaseManager;
  actionLog?: LimbActionLog;
}

export class LimbRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private deps: LimbRegistryDeps = {};

  /** 注入 Phase B 依赖（可选，不影响 Phase A 用法） */
  setDeps(deps: LimbRegistryDeps): void {
    this.deps = deps;
  }

  /** 注册一个四肢节点 */
  async register(node: ILimbNode): Promise<LimbNodeRecord> {
    if (this.entries.has(node.nodeId)) {
      throw new Error(`Limb node already registered: ${node.nodeId}`);
    }

    const now = Date.now();
    const record: LimbNodeRecord = {
      nodeId: node.nodeId,
      displayName: node.displayName,
      platform: node.platform,
      capabilities: [...node.capabilities],
      status: 'online',
      registeredAt: now,
      lastHeartbeatAt: now,
    };

    this.entries.set(node.nodeId, { node, record });
    return record;
  }

  /** 注销一个四肢节点 */
  deregister(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  /** 按 ID 获取节点元数据 */
  getNode(nodeId: string): LimbNodeRecord | undefined {
    return this.entries.get(nodeId)?.record;
  }

  /** 按 ID 获取节点实例（用于 invoke/healthCheck） */
  getNodeHandle(nodeId: string): ILimbNode | undefined {
    return this.entries.get(nodeId)?.node;
  }

  /**
   * 调用节点能力 — Phase B pipeline:
   * 1. Check node exists + online
   * 2. Find matching capability
   * 3. Access policy check (free/leased/gated)
   * 4. Acquire lease if needed
   * 5. Action log start
   * 6. Execute node.invoke()
   * 7. Action log complete/fail
   */
  async invoke(
    nodeId: string,
    command: string,
    params: Record<string, unknown>,
    context?: { catId?: string; invocationId?: string },
  ): Promise<LimbInvokeResult> {
    const entry = this.entries.get(nodeId);
    if (!entry) {
      return { success: false, error: `Unknown node: ${nodeId}` };
    }
    if (entry.record.status === 'offline') {
      return { success: false, error: `Node is offline: ${nodeId}` };
    }

    // Find matching capability — command must be in the whitelist
    const matchedCap = entry.node.capabilities.find((c) => c.commands.includes(command));
    if (!matchedCap) {
      return { success: false, error: `Command '${command}' not in any capability whitelist of node '${nodeId}'` };
    }
    const capName = matchedCap.cap;

    // Phase B: Access policy check
    const catId = context?.catId ?? 'unknown';
    let authLevel: LimbAuthLevel = matchedCap.authLevel;
    if (this.deps.accessPolicy) {
      authLevel = this.deps.accessPolicy.getEffectiveAuth(catId, nodeId, matchedCap);
    }

    if (authLevel === 'gated') {
      return { success: false, error: `Capability '${capName}' on '${nodeId}' requires approval (gated)` };
    }

    // Phase B: Lease for 'leased' resources
    let leaseId: string | null = null;
    if (authLevel === 'leased' && this.deps.leaseManager) {
      const lease = this.deps.leaseManager.acquire(catId, nodeId, capName);
      if (!lease) {
        return { success: false, error: `Capability '${capName}' on '${nodeId}' is currently leased by another cat` };
      }
      leaseId = lease.leaseId;
    }

    // Phase B: Action log
    let requestId: string | undefined;
    if (this.deps.actionLog) {
      requestId = this.deps.actionLog.start({
        invocationId: context?.invocationId ?? 'none',
        leaseId,
        catId,
        nodeId,
        capability: capName,
        command,
      });
      this.deps.actionLog.markRunning(requestId);
    }

    // Execute — auto-release lease after invoke (single-shot semantics)
    try {
      const result = await entry.node.invoke(command, params);
      if (requestId && this.deps.actionLog) {
        if (result.success) {
          this.deps.actionLog.complete(requestId, { artifactUri: result.artifactUri });
        } else {
          this.deps.actionLog.fail(requestId);
        }
      }
      return result;
    } catch (err) {
      if (requestId && this.deps.actionLog) {
        this.deps.actionLog.fail(requestId);
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Auto-release lease after single invoke — prevents "borrowed but never returned"
      if (leaseId && this.deps.leaseManager) {
        this.deps.leaseManager.release(leaseId);
      }
    }
  }

  /** 列出所有在线/可用节点（排除 offline） */
  listAvailable(): LimbNodeRecord[] {
    return [...this.entries.values()].filter((e) => e.record.status !== 'offline').map((e) => e.record);
  }

  /** 列出所有节点（含 offline） */
  listAll(): LimbNodeRecord[] {
    return [...this.entries.values()].map((e) => e.record);
  }

  /** 按能力类别查找节点（仅在线/可用） */
  findByCapability(cap: string): LimbNodeRecord[] {
    return this.listAvailable().filter((n) => n.capabilities.some((c) => c.cap === cap));
  }

  /** 更新节点状态 */
  updateStatus(nodeId: string, status: LimbNodeStatus): void {
    const entry = this.entries.get(nodeId);
    if (entry) {
      entry.record.status = status;
    }
  }

  /** 更新心跳时间 */
  recordHeartbeat(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (entry) {
      entry.record.lastHeartbeatAt = Date.now();
      if (entry.record.status === 'offline') {
        entry.record.status = 'online';
      }
    }
  }

  /** 节点数 */
  get size(): number {
    return this.entries.size;
  }
}
