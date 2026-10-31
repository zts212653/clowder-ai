/**
 * BallCustodyProjector — 消费事件 → transition → 写 projection（F233 Phase B）
 *
 * 照 CommunityProjector（F168）：apply(event) = read projection → reduce → save；rebuild = delete + replay。
 * 纯归约（transition + 字段 effect）在 ball-custody-projection-reducer.ts，供 apply / rebuild / supersession replay 共用。
 *
 * **零外部副作用**（plan §E）：projector 只做纯状态投影 + store.save，绝不做唤醒投递
 * 等外部副作用（那些在 ProbeScheduler/WakeSender 的实时 tick 路径，rebuild 不重发）。
 *
 * Invariants:
 *  - 事件永不从 log 删除（事件 facts immutable）。
 *  - rejected transition 记 lastRejectedEvent（仅 state-changing），不改 state（INV-5）。
 *  - informational reject（ball.wake_sent 非 blocked）不记 lastRejectedEvent（不污染 observability）。
 *  - rebuild(replay) 得逐字段相同 projection（INV-2，无漂移）。
 */

import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import { reduceBallCustodyEvent } from './ball-custody-projection-reducer.js';

export class BallCustodyProjector {
  constructor(
    private readonly eventLog: IBallCustodyEventLog,
    private readonly store: IBallCustodyProjectionStore,
  ) {}

  /**
   * 应用单事件到 projection。事件须已在 event log（append first）。
   * 事件语义全在共享 reducer（ball-custody-projection-reducer.ts）；这里只负责读 + 存。
   */
  async apply(event: BallCustodyEvent): Promise<{ readonly accepted: boolean }> {
    const existing = await this.store.get(event.subjectKey);
    const reduction = reduceBallCustodyEvent(existing, event);
    await this.store.save(reduction.after);
    // Whether the state machine accepted THIS event is only knowable here: the projection keeps a marker of the
    // last rejection, but any later accepted event overwrites it.
    return { accepted: reduction.accepted };
  }

  /** 重建单 subject projection：删除现有 → replay 全部事件（INV-2）。 */
  async rebuild(subjectKey: string): Promise<void> {
    await this.store.delete(subjectKey);
    const events = await this.eventLog.read(subjectKey);
    for (const event of events) {
      await this.apply(event);
    }
  }

  /** 重建所有 subject projection。 */
  async rebuildAll(): Promise<void> {
    const subjects = await this.eventLog.listSubjects();
    for (const subjectKey of subjects) {
      await this.rebuild(subjectKey);
    }
  }
}
