/**
 * BallCustodyIngest — 球权事件写入层（F233 Phase B — B2）
 *
 * 把"现有系统动作旁路写入"的 append + 写时投影封装成一个调用，照 community ingest 先例
 * （community-bootstrap.ts / community-issues.ts）：
 *
 *   const { appended } = await eventLog.append(event);
 *   if (appended) await projector.apply(event);   // appended:true guard
 *
 * **appended:true guard 是 rebuild 安全的关键**（KD-2 / community-auto-tracking 注释）：
 *  - 实时动作首次 append → appended:true → apply 写时投影。
 *  - 同 sourceEventId 重复（@ 多猫去重边界 / 重试）→ appended:false → 不二次 apply，projection 不漂移。
 *  - rebuild 走 projector.rebuild()（delete + replay），不经此路径，故不重放外部副作用（本 cell projector
 *    零外部副作用，副作用在 ProbeScheduler/WakeSender 实时 tick，B4 范围）。
 *
 * 接线点（route-serial 等）以 fire-and-forget 调用 record()：失败仅 log，不阻塞主流程；
 * 漏写的事件由后续动作 / 简报 rebuild 兜底（observability 容忍 best-effort，非账务强一致）。
 */

import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { BallCustodyProjector } from './BallCustodyProjector.js';

export interface IBallCustodyIngest {
  record(event: BallCustodyEvent): Promise<void>;
}

export class BallCustodyIngest implements IBallCustodyIngest {
  /**
   * Per-subjectKey 串行化 chain（云端 review P1-2）：调用方 fire-and-forget record()，一个 route 可对同
   * `ball:thread:*` emit 多个事件（如一条 response handoff 多猫）。projector.apply 是 read-modify-save
   * 整个 projection，若多个 apply 并发，后 save 基于 stale read 会 clobber 前一个 → holder/appliedEventCount
   * 偏离 append-only log 直到 rebuild。把同 subject 的 record 串到一条 promise chain 上，apply 串行执行
   * （不同 subject 各自独立 chain，互不阻塞）。
   */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly eventLog: IBallCustodyEventLog,
    private readonly projector: BallCustodyProjector,
  ) {}

  record(event: BallCustodyEvent): Promise<void> {
    const key = event.subjectKey;
    const prev = this.chains.get(key) ?? Promise.resolve();
    // 链到上一个 record 之后；前一个 reject 也继续（不断链）。
    const next = prev.then(
      () => this.doRecord(event),
      () => this.doRecord(event),
    );
    // chain tail 存 swallowed 版本：下一个 record 链它，不被本次 reject 污染。
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    // 完成后清理：若无后续 record 接上（chain 仍是 tail），删 map entry 防无限增长。
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  private async doRecord(event: BallCustodyEvent): Promise<void> {
    const { appended } = await this.eventLog.append(event);
    if (appended) {
      await this.projector.apply(event);
    }
  }
}
