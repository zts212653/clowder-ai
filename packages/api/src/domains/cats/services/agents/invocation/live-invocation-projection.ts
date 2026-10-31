/**
 * F297 (PR #3748 R4 P1-2) — live-invocation 执行面的 domain-owned 投影。
 *
 * 本模块只回答一个问题：**这条 thread 上，canonical live invocation 有哪些？**
 * 真相源是 record + 本进程 tracker 槽位 + durable running 子轮（F117 KD-23：不读草稿、不看时间戳），
 * 算法全部委托给 `getThreadLiveInvocations`；R 已终局的成员在此过滤掉。
 *
 * 与 `active-execution-service.ts` 的职责切分（R4 P1-2 要求，用来消除 453 行聚集）：
 * 本文件 = 单执行面的 projection + registry port + strict/fail-open adapter；
 * 那边 = 三张执行面的 candidate/working composition。本文件里的 `||` 判空分支基本都是
 * 从 `routes/queue.ts` 原样迁移的既有兼容逻辑，不是本 PR 新增的代偿层。
 */

import type { LifecycleActiveRun } from '@cat-cafe/shared';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { AgentClientActiveRunDispatcher } from '../../types.js';
import type { CodexAppServerLifecycleSnapshot } from '../providers/CodexAppServerLifecycle.js';
import { getCodexAppServerLifecycle } from '../providers/CodexAppServerLifecycleRegistry.js';
import {
  getThreadLiveInvocations,
  type LiveInvocation,
  type LivenessSource,
  type OwnerSnapshot,
} from './getThreadLiveInvocations.js';
import { projectInvocationSettlement } from './InvocationSettlementProjection.js';

/**
 * F117 KD-23: how strongly each source proves a member processing. A slot this process holds, or a
 * live CLI owner, verifies the turn; a slot whose record is not running yet is this process's own
 * pre-start window; a running child only stands in for an owner nobody could verify.
 */
const EVIDENCE_RANK: Record<LivenessSource, number> = {
  'record+tracker': 2,
  'record+owner': 2,
  'tracker-only': 1,
  'parent+child-execution': 0,
  'record-only': 0,
};

/** The candidate a cat's single slot shows: the strongest evidence, then the earliest start. */
function outranks(candidate: LiveInvocation, current: LiveInvocation): boolean {
  const byEvidence = EVIDENCE_RANK[candidate.source] - EVIDENCE_RANK[current.source];
  return byEvidence !== 0 ? byEvidence > 0 : candidate.startedAt < current.startedAt;
}

export type { OwnerSnapshot } from './getThreadLiveInvocations.js';

/** 进程内 tracker slot（控制面，非 lifecycle 真相源）。 */
export interface InvocationTrackerLike {
  has(threadId: string, catId?: string): boolean;
  getUserId(threadId: string, catId: string): string | null;
  getExecutionId?(threadId: string, catId: string): string | undefined;
  /** Canceled tombstones remain observable while provider teardown commits its durable terminal. */
  getSlotState(threadId: string, catId: string): 'active' | 'canceled' | 'absent';
  /** Optional exact identity for a canceled tombstone; absence must fail closed to repair. */
  getCanceledSlotIdentity?(threadId: string, catId: string): { executionId: string; userId: string } | undefined;
  cancel(
    threadId: string,
    catId: string,
    requestUserId?: string,
    abortReason?: string,
  ): { cancelled: boolean; catIds: string[]; executionIds?: string[] };
  /** Issue #83: Get all active slots for a thread (F5 refresh recovery) */
  getActiveSlots(threadId: string): Array<{ catId: string; startedAt: number; activeRun?: LifecycleActiveRun }>;
  /** Exact live provider seam; absence means explicit Append is unsupported now. */
  getAgentClientActiveRunDispatcher?(threadId: string, catId: string): AgentClientActiveRunDispatcher | undefined;
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
  settlement?: import('@cat-cafe/shared').QueueInvocationSettlement;
  catId: string;
  startedAt: number;
  /** Parent/control-plane identity. Frontend keeps this as the active slot key for Cancel. */
  executionId?: string;
  /** Exact child/turn identity carried by F264 body-exposure receipts. */
  turnInvocationId?: string;
  appServerLifecycle?: CodexAppServerLifecycleSnapshot;
  freshnessCarrierCapability?: import('@cat-cafe/shared').FreshnessCarrierCapability;
  activeRun?: LifecycleActiveRun;
}

export interface LifecycleProjectionCandidate {
  catId: string;
  startedAt: number;
  lifecycleOwnerId?: string;
  turnInvocationId?: string;
  activeRun?: LifecycleActiveRun;
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
  canonicalExecutionId: string | undefined,
  invocationTracker: InvocationTrackerLike,
): string | undefined {
  // The tracker is the current control-plane owner during replacement windows. When it has
  // no same-user bound execution yet, the canonical read model still carries the exact parent
  // owner. Never borrow a tracker owner from another user on a shared/default thread. When
  // neither names one, the slot stays owner-less and routes show it unresolved.
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

/** Reads a response R's lifecycle status by message id. */
export type ResponseStatusReader = (responseMessageId: string) => Promise<'processing' | 'terminal' | 'absent'>;

/** The ResponseStatusReader over the message store that holds R. */
export function responseStatusFromMessages(messageStore: Pick<IMessageStore, 'getById'>): ResponseStatusReader {
  return async (responseMessageId) => {
    const message = await Promise.resolve(messageStore.getById(responseMessageId));
    if (message?.lifecycle?.kind !== 'response') return 'absent';
    return message.lifecycle.status === 'processing' ? 'processing' : 'terminal';
  };
}

/**
 * F117 KD-23: a member is processing only while its R is. The tracker's activeRun names R once the
 * member has one; between R's terminal commit and the execution retiring its slot, the slot is still
 * held, so R's own status decides. A durable running child needs no check: invoke-single-cat ends the
 * child turn before the route commits R.
 */
async function withoutTerminalResponses(
  active: readonly LiveInvocation[],
  responseStatus: ResponseStatusReader,
): Promise<LiveInvocation[]> {
  const statuses = await Promise.all(
    active.map((live) => (live.responseMessageId ? responseStatus(live.responseMessageId) : 'processing')),
  );
  return active.filter((_, index) => statuses[index] !== 'terminal');
}

/**
 * The lifecycle candidate a cat's slot shows. The control-plane owner is the tracker's execution,
 * else the canonical one; the child turn is named only while that owner is the canonical execution.
 */
function lifecycleCandidate(
  threadId: string,
  userId: string,
  live: LiveInvocation,
  invocationTracker: InvocationTrackerLike,
  trackerActiveRunByCatId: ReadonlyMap<string, LifecycleActiveRun>,
): LifecycleProjectionCandidate {
  const lifecycleOwnerId = resolveLifecycleOwnerId(threadId, userId, live.catId, live.executionId, invocationTracker);
  const turnInvocationId =
    live.executionId !== undefined && live.invocationId !== live.executionId && lifecycleOwnerId === live.executionId
      ? live.invocationId
      : undefined;
  const activeRun = trackerActiveRunByCatId.get(live.catId);
  const exactActiveRun =
    activeRun && (activeRun.invocationId === live.invocationId || activeRun.invocationId === turnInvocationId)
      ? activeRun
      : undefined;
  return {
    catId: live.catId,
    startedAt: live.startedAt,
    ...(lifecycleOwnerId ? { lifecycleOwnerId } : {}),
    ...(turnInvocationId ? { turnInvocationId } : {}),
    ...(exactActiveRun ? { activeRun: exactActiveRun } : {}),
  };
}

/**
 * F194 Phase B / F117 KD-23: produce canonical activeInvocations using the getThreadLiveInvocations
 * helper (running record + this process's tracker slot or a durable running child). Falls back to
 * tracker-only when the record store isn't wired (legacy unit tests, embedded modes), preserving the
 * pre-F194 contract. Helper exceptions degrade to fallback + warn log in `resolveActiveInvocations`;
 * the endpoint never 500s on a liveness lookup error.
 *
 * 注意本函数**只认识 live invocation 一张脸**。managed command / standalone running child
 * 由 `createActiveExecutionService` 的另外两条通道定性，不要试图在这里补。
 */
export async function resolveActiveInvocationsStrict(
  threadId: string,
  userId: string,
  invocationTracker: InvocationTrackerLike,
  recordStore: IInvocationRecordStore | undefined,
  responseStatus: ResponseStatusReader | undefined,
  turnExecutionStore: Pick<ITurnExecutionStore, 'listByParent'> | undefined,
  /** F117 KD-23: the caller's CLI owner snapshot; without a complete one, running members stay listed unverified. */
  ownerSnapshot?: OwnerSnapshot,
): Promise<ActiveInvocationProjection[]> {
  if (!recordStore) {
    return projectActiveInvocations(threadId, trackerProjectionCandidates(threadId, userId, invocationTracker));
  }
  const childrenByParent = new Map<string, Awaited<ReturnType<ITurnExecutionStore['listByParent']>>>();
  const result = await getThreadLiveInvocations(threadId, userId, {
    listRunningRecords: (tid, uid) => recordStore.listRunningByThread(tid, uid),
    getActiveSlots: (tid) => invocationTracker.getActiveSlots(tid),
    getTrackerUserId: (tid, cid) => invocationTracker.getUserId(tid, cid),
    getTrackerExecutionId: (tid, cid) => invocationTracker.getExecutionId?.(tid, cid),
    ...(turnExecutionStore
      ? {
          listTurnExecutionsByParent: async (parentId: string) => {
            const children = await turnExecutionStore.listByParent(parentId);
            childrenByParent.set(parentId, children);
            return children;
          },
        }
      : {}),
    ...(ownerSnapshot ? { ownerSnapshot } : {}),
  });
  const active = responseStatus ? await withoutTerminalResponses(result.active, responseStatus) : result.active;
  // Read the dynamic Active Run only after the asynchronous canonical liveness
  // snapshot. Child admission can bind the run while record/child stores are
  // being read; taking this map before the await returns a torn `/queue`
  // projection (new child identity + missing run), which then erases the newer
  // websocket run during authoritative frontend hydration.
  const trackerActiveRunByCatId = new Map(
    invocationTracker
      .getActiveSlots(threadId)
      .filter((slot): slot is typeof slot & { activeRun: LifecycleActiveRun } => Boolean(slot.activeRun))
      .map((slot) => [slot.catId, slot.activeRun]),
  );
  // Cloud R15 P2: dedup by catId. The helper can yield more than one LiveInvocation for the same cat
  // (e.g. two running records, one proven by a durable child). Frontend replaceThreadTargetCats treats
  // activeInvocations[].catId as cat-level state, so duplicates would render the same cat slot twice.
  // F117 KD-23: the slot shows the strongest evidence, so an unverified child of an older execution
  // never hides the execution this process runs; within the same evidence, the earliest start wins.
  const chosen = new Map<string, LiveInvocation>();
  for (const s of active) {
    const existing = chosen.get(s.catId);
    if (!existing || outranks(s, existing)) chosen.set(s.catId, s);
  }
  const candidates = Array.from(chosen.values(), (live) =>
    lifecycleCandidate(threadId, userId, live, invocationTracker, trackerActiveRunByCatId),
  );
  return projectActiveInvocations(threadId, candidates).map((slot) => {
    if (!slot.executionId || !slot.turnInvocationId) return slot;
    const settlement = projectInvocationSettlement(
      { threadId, userId, catId: slot.catId, executionId: slot.executionId, turnInvocationId: slot.turnInvocationId },
      childrenByParent.get(slot.executionId) ?? [],
    );
    return settlement ? { ...slot, settlement } : slot;
  });
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
  responseStatus: ResponseStatusReader | undefined,
  turnExecutionStore: Pick<ITurnExecutionStore, 'listByParent'> | undefined,
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  ownerSnapshot?: OwnerSnapshot,
): Promise<ActiveInvocationProjection[]> {
  try {
    return await resolveActiveInvocationsStrict(
      threadId,
      userId,
      invocationTracker,
      recordStore,
      responseStatus,
      turnExecutionStore,
      ownerSnapshot,
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
