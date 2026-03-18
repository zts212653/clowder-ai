/**
 * LimbPresenceManager — F126 四肢节点在线状态管理
 *
 * 通过心跳机制追踪四肢节点的在线状态。
 * 超时的节点自动标记为 offline，能力从可用列表移除。
 */

import type { LimbNodeStatus } from '@cat-cafe/shared';
import type { LimbRegistry } from './LimbRegistry.js';

export type StatusChangeCallback = (nodeId: string, from: LimbNodeStatus, to: LimbNodeStatus) => void;

export interface LimbPresenceOptions {
  /** 超时阈值（ms），超过此时间无心跳则标记 offline */
  timeoutMs: number;
  /** 检查间隔（ms） */
  checkIntervalMs: number;
}

const DEFAULT_OPTIONS: LimbPresenceOptions = {
  timeoutMs: 45_000, // 45s（3 次心跳未到）
  checkIntervalMs: 15_000, // 15s 检查一次
};

/**
 * 将 F118 ProcessLivenessProbe 的 4 态映射到 LimbNodeStatus。
 * Phase A 只做映射函数，不改 ProcessLivenessProbe 本身。
 */
export function mapProbeStateToLimbStatus(
  probeState: 'active' | 'busy-silent' | 'idle-silent' | 'dead',
): LimbNodeStatus {
  switch (probeState) {
    case 'active':
      return 'online';
    case 'busy-silent':
      return 'busy';
    case 'idle-silent':
      return 'degraded';
    case 'dead':
      return 'offline';
  }
}

export class LimbPresenceManager {
  private readonly registry: LimbRegistry;
  private readonly options: LimbPresenceOptions;
  private readonly listeners: StatusChangeCallback[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(registry: LimbRegistry, options?: Partial<LimbPresenceOptions>) {
    this.registry = registry;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 检查所有节点，超时的标记 offline */
  checkAll(): void {
    const now = Date.now();
    for (const node of this.registry.listAll()) {
      if (node.status === 'offline') continue;

      const elapsed = now - node.lastHeartbeatAt;
      if (elapsed > this.options.timeoutMs) {
        const oldStatus = node.status;
        this.registry.updateStatus(node.nodeId, 'offline');
        this.notifyListeners(node.nodeId, oldStatus, 'offline');
      }
    }
  }

  /** 注册状态变更回调 */
  onStatusChange(cb: StatusChangeCallback): void {
    this.listeners.push(cb);
  }

  /** 启动定时检查 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAll(), this.options.checkIntervalMs);
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this.timer !== null;
  }

  private notifyListeners(nodeId: string, from: LimbNodeStatus, to: LimbNodeStatus): void {
    for (const cb of this.listeners) {
      cb(nodeId, from, to);
    }
  }
}
