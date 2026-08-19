/**
 * F297 (PR #3748 R4 P1-2) — live-invocation 执行面的 domain-owned 投影。
 *
 * 本模块只回答一个问题：**这条 thread 上，canonical live invocation 有哪些？**
 * 真相源是 record + tracker + draft（+ F194 child bridge / registry namespace bridge），
 * 算法全部委托给 `getThreadLiveInvocations`，此处不复制任何 liveness 规则。
 *
 * 与 `active-execution-service.ts` 的职责切分（R4 P1-2 要求，用来消除 453 行聚集）：
 * 本文件 = 单执行面的 projection + registry port + strict/fail-open adapter；
 * 那边 = 三张执行面的 candidate/working composition。本文件里的 `||` 判空分支基本都是
 * 从 `routes/queue.ts` 原样迁移的既有兼容逻辑，不是本 PR 新增的代偿层。
 */

import type { IDraftStore } from '../../stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { CodexAppServerLifecycleSnapshot } from '../providers/CodexAppServerLifecycle.js';
import { getCodexAppServerLifecycle } from '../providers/CodexAppServerLifecycleRegistry.js';
import { getThreadLiveInvocations } from './getThreadLiveInvocations.js';

/** 进程内 tracker slot（控制面，非 lifecycle 真相源）。 */
export interface InvocationTrackerLike {
  has(threadId: string, catId?: string): boolean;
  getUserId(threadId: string, catId: string): string | null;
  getExecutionId?(threadId: string, catId: string): string | undefined;
  cancel(
    threadId: string,
    catId: string,
    requestUserId?: string,
    abortReason?: string,
  ): { cancelled: boolean; catIds: string[]; executionIds?: string[] };
  /** Issue #83: Get all active slots for a thread (F5 refresh recovery) */
  getActiveSlots(threadId: string): Array<{ catId: string; startedAt: number }>;
  /** 稀疏候选索引：本进程持有 slot 的 thread。 */
  listActiveThreadIds?(): string[];
  /** F-invocation-stale-recovery: Cancel ALL active slots for a thread (abort controllers + delete slots). */
  cancelAll?(
    threadId: string,
    requestUserId?: string,
    abortReason?: string,
  ): { catIds: string[]; executionIds: string[]; executionIdByCatId?: Readonly<Record<string, string>> };
}

/**
 * F194 Phase Z (KD-22) namespace bridge，**domain-owned**（R3 P2-1）。
 *
 * 以前这个形状只存在于 `QueueRoutesOptions['invocationRegistry']`，等于把 domain 契约
 * 寄存在 route 的 options 里。现在 route 反过来引用本类型。
 */
export interface InvocationRegistryPort {
  getRecord(invocationId: string): Promise<{
    parentInvocationId?: string | undefined;
    threadId: string;
    userId: string;
    catId: string;
    createdAt: number;
  } | null>;
  getLatestId(threadId: string, catId: string): Promise<string | undefined>;
}

export interface ActiveInvocationProjection {
  catId: string;
  startedAt: number;
  /** Parent/control-plane identity. Frontend keeps this as the active slot key for Cancel. */
  executionId?: string;
  /** Exact child/turn identity carried by F264 body-exposure receipts. */
  turnInvocationId?: string;
  appServerLifecycle?: CodexAppServerLifecycleSnapshot;
  freshnessCarrierCapability?: import('@cat-cafe/shared').FreshnessCarrierCapability;
}

export interface LifecycleProjectionCandidate {
  catId: string;
  startedAt: number;
  lifecycleOwnerId?: string;
  turnInvocationId?: string;
}

export function getRequestOwnedTrackerExecutionId(
  threadId: string,
  userId: string,
  catId: string,
  invocationTracker: InvocationTrackerLike,
): string | undefined {
  if (invocationTracker.getUserId(threadId, catId) !== userId) return undefined;
  return invocationTracker.getExecutionId?.(threadId, catId);
}

function resolveLifecycleOwnerId(
  threadId: string,
  userId: string,
  catId: string,
  canonicalExecutionId: string,
  invocationTracker: InvocationTrackerLike,
): string {
  // The tracker is the current control-plane owner during replacement windows. When it has
  // no same-user bound execution yet, the canonical read model still carries the exact parent
  // owner. Never borrow a tracker owner from another user on a shared/default thread.
  return getRequestOwnedTrackerExecutionId(threadId, userId, catId, invocationTracker) ?? canonicalExecutionId;
}

export function projectActiveInvocations(
  threadId: string,
  slots: LifecycleProjectionCandidate[],
): ActiveInvocationProjection[] {
  return slots.map(({ lifecycleOwnerId, ...slot }) => {
    const appServerLifecycle = lifecycleOwnerId
      ? getCodexAppServerLifecycle(threadId, slot.catId, lifecycleOwnerId)
      : undefined;
    const projection = {
      ...slot,
      ...(lifecycleOwnerId ? { executionId: lifecycleOwnerId } : {}),
    };
    return appServerLifecycle ? { ...projection, appServerLifecycle } : projection;
  });
}

export function trackerProjectionCandidates(
  threadId: string,
  userId: string,
  invocationTracker: InvocationTrackerLike,
): LifecycleProjectionCandidate[] {
  return invocationTracker.getActiveSlots(threadId).map((slot) => {
    const lifecycleOwnerId = getRequestOwnedTrackerExecutionId(threadId, userId, slot.catId, invocationTracker);
    return { ...slot, ...(lifecycleOwnerId ? { lifecycleOwnerId } : {}) };
  });
}

/**
 * F194 Phase B: produce canonical activeInvocations using getThreadLiveInvocations helper
 * (record + tracker + draft 收口为单一 read model). Falls back to tracker-only when the
 * record/draft stores aren't wired (legacy unit tests, embedded modes), preserving the
 * pre-F194 contract. Helper exceptions degrade to fallback + warn log; the endpoint never
 * 500s on a liveness lookup error.
 *
 * 注意本函数**只认识 live invocation 一张脸**。managed command / standalone running child
 * 由 `createActiveExecutionService` 的另外两条通道定性，不要试图在这里补。
 */
export async function resolveActiveInvocationsStrict(
  threadId: string,
  userId: string,
  invocationTracker: InvocationTrackerLike,
  recordStore: IInvocationRecordStore | undefined,
  draftStore: IDraftStore | undefined,
  turnExecutionStore: Pick<ITurnExecutionStore, 'listByParent'> | undefined,
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  invocationRegistry?: InvocationRegistryPort,
): Promise<ActiveInvocationProjection[]> {
  if (!recordStore || !draftStore) {
    return projectActiveInvocations(threadId, trackerProjectionCandidates(threadId, userId, invocationTracker));
  }
  {
    const result = await getThreadLiveInvocations(threadId, userId, {
      listRunningRecords: (tid, uid) => recordStore.listRunningByThread(tid, uid),
      getActiveSlots: (tid) => invocationTracker.getActiveSlots(tid),
      getTrackerUserId: (tid, cid) => invocationTracker.getUserId(tid, cid),
      getDrafts: (uid, tid) => draftStore.getByThread(uid, tid),
      ...(turnExecutionStore
        ? { listTurnExecutionsByParent: (parentId: string) => turnExecutionStore.listByParent(parentId) }
        : {}),
      // F194 Phase Z (KD-22): namespace bridge — parent recordStore invocation ↔ per-cat-turn
      // child registry invocation. Wraps InvocationRegistry.getRecord (parentInvocationId field)
      // + getLatestId. Optional — when absent, helper falls back to legacy single-namespace path.
      ...(invocationRegistry
        ? {
            getTurnInvocation: async (id: string) => {
              const rec = await invocationRegistry.getRecord(id);
              if (!rec) return null;
              return {
                parentInvocationId: rec.parentInvocationId,
                threadId: rec.threadId,
                userId: rec.userId,
                catId: rec.catId,
                createdAt: rec.createdAt,
              };
            },
            getLatestTurnInvocationId: (tid: string, cat: string) => invocationRegistry.getLatestId(tid, cat),
          }
        : {}),
      // F194 AC-B12: route diagnostic events into request log. NB: do NOT spread `source: 'F194'`
      // — that would clobber LivenessEvent.source (record+draft / record-only / tracker+draft / null),
      // losing the most diagnostic field. Use `feature` for the F194 marker instead.
      onLog: (event) => log.info({ ...event, feature: 'F194' }, 'F194 liveness event'),
    });
    // Zombie candidates are diagnostic output only. The explicit owner reaper owns
    // all terminal writes; GET /queue remains observational.
    // 砚砚 R5 P2: filter null catId — frontend turns queue.activeInvocations[].catId into a
    // real target cat slot identifier (replaceThreadTargetCats / hydrated-{threadId}-{catId}).
    // null catId can only happen for the corner case where a record has no targetCats AND no
    // draft — those entries can't surface as actionable queue slots, so drop them here.
    //
    // Cloud R15 P2: dedup by catId. Helper can yield multiple LiveInvocations for the same cat
    // during recovery windows (e.g., two concurrent `running` records). Frontend
    // replaceThreadTargetCats treats activeInvocations[].catId as cat-level state, so duplicates
    // would render the same cat slot twice. Keep earliest startedAt as the canonical slot age.
    const byCatId = new Map<string, LifecycleProjectionCandidate>();
    for (const s of result.active) {
      if (s.catId === null || s.catId === undefined) continue;
      const existing = byCatId.get(s.catId);
      if (!existing || s.startedAt < existing.startedAt) {
        const lifecycleOwnerId = resolveLifecycleOwnerId(threadId, userId, s.catId, s.executionId, invocationTracker);
        const turnInvocationId =
          s.invocationId !== s.executionId && lifecycleOwnerId === s.executionId ? s.invocationId : undefined;
        byCatId.set(s.catId, {
          catId: s.catId,
          startedAt: s.startedAt,
          lifecycleOwnerId,
          ...(turnInvocationId ? { turnInvocationId } : {}),
        });
      }
    }
    return projectActiveInvocations(threadId, Array.from(byCatId.values()));
  }
}

/**
 * GET /queue 的 fail-open 包装：helper 失败降级成 tracker-only，端点永不因 liveness 查询 500。
 *
 * **Sidebar 不能用这个。** 降级把"读失败"伪装成"这些就是全部"，presence 于是空手而归、
 * 行掉进 participant-activity 终态回落 —— 正在跑的 thread 被显示成 done。C10 走
 * `resolveActiveInvocationsStrict`，让失败以异常形式抵达 `resolveWorkingPresence` 的
 * completeness 记账，再由调用方 fail-closed 封成 idle。
 */
export async function resolveActiveInvocations(
  threadId: string,
  userId: string,
  invocationTracker: InvocationTrackerLike,
  recordStore: IInvocationRecordStore | undefined,
  draftStore: IDraftStore | undefined,
  turnExecutionStore: Pick<ITurnExecutionStore, 'listByParent'> | undefined,
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  invocationRegistry?: InvocationRegistryPort,
): Promise<ActiveInvocationProjection[]> {
  try {
    return await resolveActiveInvocationsStrict(
      threadId,
      userId,
      invocationTracker,
      recordStore,
      draftStore,
      turnExecutionStore,
      log,
      invocationRegistry,
    );
  } catch (err) {
    // F194 AC-B13: fallback metric — split-brain protection bypassed when this fires.
    log.warn(
      { err, kind: 'liveness_fallback', threadId, userId, feature: 'F194', endpoint: '/queue' },
      'F194 helper failed, fall-back tracker-only',
    );
    return projectActiveInvocations(threadId, trackerProjectionCandidates(threadId, userId, invocationTracker));
  }
}
