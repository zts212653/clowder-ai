/**
 * F224 SessionContinuationCoordinator — continuation lifecycle owner.
 *
 * 四象限坐标系（设计图 `docs/plans/2026-06-04-session-continuation-coordinator-design.md`）：
 *   Coordinator(continuation lifecycle) / Queue(A2A fan-in) / Route(route state) / Invoke(session runtime)
 *
 * F220 边界硬隔离（砚砚 Q5）：deps **不含** InvocationTracker / processing slot / cancel /
 * force-reset / releaseSlot。coordinator 只做 continuation 的「决策 + 提交」，从结构上挡住
 * F220 Phase 2 的 invocation-hang 轴揉进来——以后谁想加 tracker/cancel，deps 类型就编译不过。
 *
 * 本文件是 A 方案的 maintainer-owned skeleton（KD-3 hybrid）：钉死坐标系第一刀，
 * Phase A 局部实现可由社区 follow-up patch 接（clowder-ai#834 吴浪）。
 *
 * 接口契约 **全 async**（砚砚 review P1）：真实 threadStore 是 Redis async（`IThreadStore`
 * 已用 `T | Promise<T>`，Phase A 需要 Redis Lua 原子 consume）。一次把 contract 钉成 async，
 * 吴浪 Phase A 接 Redis 时不用重写 public API。
 */

import { type CollaborationContinuityCapsuleV1, formatContinuationPrompt } from './CollaborationContinuityCapsule.js';

export type SessionStrategy = 'resume' | 'reborn';

/** deps 方法返回值——兼容 sync 测试 fake + async Redis（与 `IThreadStore` 的 `T | Promise<T>` 对齐）。 */
type Awaitable<T> = T | Promise<T>;

/** invocation 的终态。砚砚 P1：`canceled_by_user` 是实际存在的状态，不能漏。 */
export type InvocationFinalStatus = 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user';

/**
 * consume 了什么的记账——commit 时若 finalStatus 非 succeeded，用它把 capsule restore 回 pending
 * （砚砚 P1 corner case：consumed continuation 在 failure/cancel 上 restore）。
 * 注意：restore 用本 token 自身记录的 identity（threadId/catId/userId），不是 commit input 的（砚砚 P2）。
 */
export interface ConsumedContinuationToken {
  capsule: CollaborationContinuityCapsuleV1;
  threadId: string;
  catId: string;
  userId: string;
}

export interface PrepareInvocationInput {
  threadId: string;
  catId: string;
  userId: string;
  content: string;
}

export interface PrepareInvocationResult {
  /** resume+pending 时为「注入 continuation prompt 后的 content」，否则原样返回。 */
  content: string;
  /** resume+pending 时记账被 consume 的 capsule；commit failure/cancel 时据此 restore。 */
  consumedContinuation?: ConsumedContinuationToken;
  sessionPolicy: SessionStrategy;
}

export interface CommitInvocationInput {
  finalStatus: InvocationFinalStatus;
  threadId: string;
  catId: string;
  userId: string;
  /** 来自 prepare 的记账，用于 failure/cancel restore。 */
  consumedContinuation?: ConsumedContinuationToken;
  /** 本次 invocation 产出的 capsule（砚砚 P1：多猫多 capsule，故 Iterable 非单数）。 */
  producedCapsules?: Iterable<CollaborationContinuityCapsuleV1>;
}

export interface SessionContinuationCoordinatorDeps {
  threadStore: {
    /** #836 reborn：集中 policy read 的数据源（不散 4 处 isRebornSession）。 */
    getMemberSessionStrategy(threadId: string, catId: string, userId: string): Awaitable<SessionStrategy | undefined>;
    /** #813 passive seal：原子 consume pending continuation（Redis Lua HGET+HDEL 防并发双消费）。 */
    consumePendingContinuation(
      threadId: string,
      catId: string,
      userId: string,
    ): Awaitable<CollaborationContinuityCapsuleV1 | null>;
    /** #813 passive seal：写 pending continuation（success 存 produced / failure restore consumed）。 */
    setPendingContinuation(
      threadId: string,
      catId: string,
      userId: string,
      capsule: CollaborationContinuityCapsuleV1,
    ): Awaitable<void>;
  };
}

export class SessionContinuationCoordinator {
  constructor(private readonly deps: SessionContinuationCoordinatorDeps) {}

  /**
   * #836：集中 `resume | reborn` 决策，调用方（queue / direct invocation 入口）只拿结果，
   * 不到处自己查 store。direct path 和 QueueProcessor path 共用此入口 → 不分叉。
   */
  async resolveSessionStrategy(threadId: string, catId: string, userId: string): Promise<SessionStrategy> {
    return (await this.deps.threadStore.getMemberSessionStrategy(threadId, catId, userId)) ?? 'resume';
  }

  /**
   * #813 + #836：单猫 invocation 开始前的 continuation 决策 + content 改写。
   * - **reborn（per-cat via resolveSessionStrategy）**：跳过 consume，原 content 直接跑。
   * - **resume + pending capsule**：原子 consume + 注入 continuation prompt + 记账 token。
   * - **resume + 无 pending**：原 content。
   */
  async prepareInvocationContext(input: PrepareInvocationInput): Promise<PrepareInvocationResult> {
    const { threadId, catId, userId, content } = input;
    const sessionPolicy = await this.resolveSessionStrategy(threadId, catId, userId);

    if (sessionPolicy === 'reborn') {
      return { content, sessionPolicy };
    }

    const capsule = await this.deps.threadStore.consumePendingContinuation(threadId, catId, userId);
    if (!capsule) {
      return { content, sessionPolicy };
    }

    const continuationPrompt = formatContinuationPrompt(capsule);
    return {
      content: `${continuationPrompt}\n\n${content}`,
      consumedContinuation: { capsule, threadId, catId, userId },
      sessionPolicy,
    };
  }

  /**
   * #813 + #836：invocation 收尾的 continuation 提交。优先级（砚砚 P1）：
   * 1. **reborn（per-cat，砚砚 re-review）** → 该 cat 的 capsule/token 跳过（按数据自身 cat 判，不按 commit input 整体判）。
   * 2. **本次产出新 capsule（produced 非空）** → 存新的，优先于 restore（无论 success/failure，
   *    避免 failure 中产生的最新状态被旧的覆盖丢失）。每个 capsule 存到**它自己携带的**
   *    threadId/catId（砚砚 P1#2：多猫场景下不能都塞 commit input 的 catId）。
   * 3. **succeeded 且无 produced** → 无 continuation 可存。
   * 4. **failure/cancel/canceled_by_user 且无 produced 但有 consumed** → restore consumed，
   *    用 **token 自身记账的 identity**（砚砚 P2：token 就是为了记录 consume 了谁的）。
   */
  async commitInvocationOutcome(input: CommitInvocationInput): Promise<void> {
    const { finalStatus, userId, consumedContinuation, producedCapsules } = input;

    const produced = producedCapsules ? Array.from(producedCapsules) : [];

    // 云端 P1 + P1#2 fix：track 是否有 capsule 真正覆盖了 consumed 的 identity。
    // 只有覆盖了（same threadId+catId）才跳过 restore；存了别的 cat 的 capsule 不算覆盖。
    let consumedSuperseded = false;
    for (const capsule of produced) {
      // 云端 P1#3：cross-thread guard（parity with QueueProcessor.enqueueContinuation）。
      // 防 malformed/hallucinated capsule 污染其他 thread 的 continuation state。
      if (capsule.threadId !== input.threadId) {
        continue;
      }
      // #836 per-cat（砚砚 re-review）：按 capsule 自身 cat 判 strategy，reborn 跳过这一个——
      // 不按 commit input 整体判，否则混合 resume/reborn 多猫场景会错存 reborn / 错丢 resume。
      if ((await this.resolveSessionStrategy(capsule.threadId, capsule.catId, userId)) === 'reborn') {
        continue;
      }
      // 砚砚 P1#2：存到 capsule 自身携带的 (threadId, catId)，不是 commit input 的 catId。
      await this.deps.threadStore.setPendingContinuation(capsule.threadId, capsule.catId, userId, capsule);
      // 云端 P1#2：只有覆盖了 consumed token 的 identity 才算 superseded
      if (
        consumedContinuation &&
        capsule.threadId === consumedContinuation.threadId &&
        capsule.catId === consumedContinuation.catId
      ) {
        consumedSuperseded = true;
      }
    }
    // consumed 被新 capsule 覆盖 → 不需要 restore。
    if (consumedSuperseded) {
      return;
    }

    if (finalStatus === 'succeeded') {
      return;
    }

    if (consumedContinuation) {
      // #836 per-cat（砚砚 re-review）：按 token 自身 cat 判 strategy，reborn 则不 restore。
      if (
        (await this.resolveSessionStrategy(
          consumedContinuation.threadId,
          consumedContinuation.catId,
          consumedContinuation.userId,
        )) === 'reborn'
      ) {
        return;
      }
      // 砚砚 P2：restore 用 token 自身记账的 identity，不是 commit input 的 identity。
      await this.deps.threadStore.setPendingContinuation(
        consumedContinuation.threadId,
        consumedContinuation.catId,
        consumedContinuation.userId,
        consumedContinuation.capsule,
      );
    }
  }
}
