/**
 * F183 Phase C — Thread-scoped monotonic sequence number.
 *
 * KD-9 (2026-05-02 拍板)：选 thread-scoped 而不是 global monotonic。
 * 每个 thread 独立编号，跨 thread 不保证全局顺序（用户场景没需求）。
 *
 * 实施约束：
 * - 单实例 in-memory（KD-9 拒绝 multi-instance 分布式 sequencer over-engineering）
 * - API 重启 → counter reset；instance epoch (boot UUID) 跟着重置，client 比对
 *   epoch 不一致 → 重置 lastSeq + 触发 catch-up（砚砚 R1 P1 修复）
 * - 消息归属由 `threadId` 字段决定，跟 seq 无关 — 漂气泡风险通过 ADR-033 已解决
 *
 * 配套：client `processThreadSeq` (useAgentMessages.ts) 用 (epoch, seq) 做 gap
 * detection + 触发 `requestStreamCatchUp(threadId)`。
 */
import { randomUUID } from 'node:crypto';

export class ThreadSequencer {
  private threadSeqs: Map<string, number> = new Map();
  /**
   * F183 Phase C (砚砚 R1 P1 fix) — instance epoch identifies this sequencer
   * generation. Generated at construction (typically API boot). Client uses
   * it to detect server restart: if incoming epoch differs from lastSeqEpoch
   * for that thread, client resets lastSeq + triggers catch-up.
   *
   * Without epoch, restart could leave client with high-water lastSeq=500
   * while server emits seq=1,2,3... — client would treat all as 'late' and
   * gap detection silently fails until server catches back up.
   */
  private readonly _epoch: string;

  constructor(epochOverride?: string) {
    this._epoch = epochOverride ?? randomUUID();
  }

  /** F183 Phase C — instance epoch (server boot UUID). Stable for sequencer lifetime. */
  get epoch(): string {
    return this._epoch;
  }

  /** Increment + return next seq for thread. First call returns 1. */
  next(threadId: string): number {
    const next = (this.threadSeqs.get(threadId) ?? 0) + 1;
    this.threadSeqs.set(threadId, next);
    return next;
  }

  /** Read current seq without incrementing. Returns 0 for unseen thread. */
  peek(threadId: string): number {
    return this.threadSeqs.get(threadId) ?? 0;
  }

  /**
   * F183 Phase C cloud R3 P2 fix (2026-05-02) — bump counter to at least
   * `seq` for thread, preserving monotonicity if `seq > current`. Used by
   * `SocketManager.broadcastAgentMessage` when caller provides a seq override:
   * without this, subsequent auto-assigned seqs could reuse lower numbers
   * (often restarting from 1) and clients would treat fresh events as
   * 'late'/'gap'. Idempotent — bumpTo(threadId, smaller) is no-op.
   */
  bumpTo(threadId: string, seq: number): void {
    if (typeof seq !== 'number' || seq <= 0) return;
    const current = this.threadSeqs.get(threadId) ?? 0;
    if (seq > current) this.threadSeqs.set(threadId, seq);
  }

  /**
   * Test/admin only: reset a thread's seq counter to 0.
   * Production should never need this — restart resets via process recycle.
   */
  reset(threadId: string): void {
    this.threadSeqs.delete(threadId);
  }

  /** Test only: clear all thread seq state. */
  resetAll(): void {
    this.threadSeqs.clear();
  }
}
