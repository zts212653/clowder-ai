import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  listManagedCommandExecutions,
  type ManagedCommandExecution,
} from '../domains/cats/services/agents/invocation/active-execution-service.js';
import { resolveThreadAccess, threadAccessDeniedBody } from '../domains/cats/services/session/thread-access-policy.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { DynamicTaskDef } from '../infrastructure/scheduler/DynamicTaskStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface LiveExecutionCandidate {
  readonly catId: string;
  readonly startedAt: number;
  readonly executionId?: string;
  /** Exact child process id; internal only and never serialized. */
  readonly invocationId?: string;
  /** Runtime principal. Visibility and control authority are separate decisions. */
  readonly ownerUserId?: string;
  readonly controlSource?: 'tracker' | 'process_owner' | 'unavailable';
}

interface ActiveExecutionTracker {
  getUserId(threadId: string, catId: string): string | null;
  getExecutionId?(threadId: string, catId: string): string | undefined;
}

/** 稀疏 live 候选来源（F297 AC-D3）：只收窄 live 定性；managed command 由自己的投影读取。 */
export type LiveExecutionCandidateSnapshotSource = (
  userId: string,
  request: FastifyRequest,
) => Promise<{ readonly threadIds: readonly string[]; readonly complete: boolean }>;

export interface ActiveExecutionRouteDeps {
  readonly threadStore: IThreadStore;
  /**
   * F297 AC-D3：把 F295 的 4 秒 project scan 从 O(T) 收窄到 O(A)。这里只读取
   * live/child 候选；managed-command 表随后会为完整投影读取一次，不能在候选阶段重复读取。
   * 缺省（未接线）时退回全量扫描，行为不变。
   */
  readonly buildLiveCandidateSnapshot?: LiveExecutionCandidateSnapshotSource;
  readonly invocationTracker: ActiveExecutionTracker;
  readonly dynamicTaskStore?: Pick<{ getAll(): DynamicTaskDef[] }, 'getAll'>;
  readonly resolveLiveExecutions: (
    threadId: string,
    userId: string,
    request: FastifyRequest,
  ) => Promise<LiveExecutionCandidate[]>;
  /** False means a durable process-owner source could not be read on this request. */
  readonly isLiveExecutionControlPlaneComplete?: (request: FastifyRequest) => Promise<boolean>;
  readonly cancelExactLiveInvocation: (input: {
    threadId: string;
    userId: string;
    catId: string;
    executionId: string;
    candidate: LiveExecutionCandidate;
    request: FastifyRequest;
  }) =>
    | { cancelled: boolean; controlPlaneUnavailable?: boolean }
    | Promise<{ cancelled: boolean; controlPlaneUnavailable?: boolean }>;
}

const cancelLiveBodySchema = z.object({ catId: z.string().min(1).max(100) }).strict();

/** `listByProject` is already user-index scoped; retain the legacy owner/system guard against malformed indexes. */
function canProjectThread(thread: Thread, userId: string): boolean {
  return thread.createdBy === 'system' || thread.createdBy === userId;
}

function unresolvedExecutionId(threadId: string, candidate: LiveExecutionCandidate): string {
  return `unresolved:${threadId}:${candidate.catId}:${candidate.startedAt}`;
}

/**
 * Occupancy identity for a run this viewer does not own.
 *
 * The real `task.id` is a capability handle, not just a label: it resolves at
 * `GET/DELETE /api/callbacks/hold-ball/:taskId`, whose authorization is
 * thread-scoped rather than principal-scoped. Publishing it would have turned a
 * foreign scheduler round into a discoverable read-and-cancel handle, so foreign
 * rows carry a stable but deliberately unresolvable id instead.
 */
function foreignOccupancyExecutionId(threadId: string, catId: string, startedAt: number): string {
  return `occupied:${threadId}:${catId}:${startedAt}`;
}

function canControlLiveExecution(thread: Thread, userId: string, candidate: LiveExecutionCandidate): boolean {
  const ownerUserId = candidate.ownerUserId ?? userId;
  if (ownerUserId === userId) return true;
  return thread.createdBy === userId && (ownerUserId === 'scheduler' || ownerUserId === 'system');
}

function projectLiveExecution(
  thread: Thread,
  userId: string,
  candidate: LiveExecutionCandidate,
  tracker: ActiveExecutionTracker,
): ActiveExecutionProjection {
  const canControl = canControlLiveExecution(thread, userId, candidate);
  const trackerExecutionId =
    tracker.getUserId(thread.id, candidate.catId) === userId
      ? tracker.getExecutionId?.(thread.id, candidate.catId)
      : undefined;
  const realExecutionId = candidate.executionId ?? unresolvedExecutionId(thread.id, candidate);
  const executionId = canControl
    ? realExecutionId
    : foreignOccupancyExecutionId(thread.id, candidate.catId, candidate.startedAt);
  const controlAvailable =
    candidate.controlSource === 'process_owner' ||
    candidate.controlSource === 'tracker' ||
    trackerExecutionId === realExecutionId;
  return {
    executionId,
    threadId: thread.id,
    threadTitle: thread.title,
    catId: candidate.catId,
    kind: 'live_invocation',
    startedAt: candidate.startedAt,
    cancelability:
      canControl && controlAvailable && candidate.executionId
        ? {
            state: 'cancelable',
            target: {
              kind: 'live_invocation',
              threadId: thread.id,
              catId: candidate.catId,
              executionId: realExecutionId,
            },
          }
        : {
            state: 'not_cancelable',
            reason: canControl ? 'control_plane_unavailable' : 'foreign_principal',
          },
  };
}

function sortExecutions(executions: ActiveExecutionProjection[]): ActiveExecutionProjection[] {
  return executions.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.threadId.localeCompare(right.threadId) ||
      left.executionId.localeCompare(right.executionId),
  );
}

/**
 * managed command → 列表投影。判别式**不在这里**：它属于 domain 的
 * `listManagedCommandExecutions`（PR #3748 R3 P2-1）。以前这里有一份独立的
 * active/retired 判别拷贝，Sidebar 又有另一份候选判别，两份漂移就会让
 * "执行列表说在跑、Sidebar 说 done"。现在两个 consumer 共用同一个枚举器。
 *
 * PR #3763（rebase 合流）：枚举器 principal-blind——thread access 是可见性边界
 * （threadById 只含该用户可读的 thread），trigger ownership 只决定"能不能停"，
 * 不决定"能不能看见"。把 scheduler 拥有的 round 从列表里滤掉会让被占用的
 * cat slot 看起来空闲，新工作在隐形占用者后面排队。投影不携带 command 文本；
 * foreign 行的 executionId 用不可解析的合成 id（真 task.id 是 capability handle）。
 */
function projectManagedCommandExecution(
  execution: ManagedCommandExecution,
  userId: string,
  threadById: ReadonlyMap<string, Thread>,
): ActiveExecutionProjection | null {
  const thread = threadById.get(execution.threadId);
  if (!thread) return null;
  const ownedByViewer = execution.userId === userId;
  return {
    executionId: ownedByViewer
      ? execution.taskId
      : foreignOccupancyExecutionId(thread.id, execution.catId, execution.startedAt),
    threadId: thread.id,
    threadTitle: thread.title,
    catId: execution.catId,
    kind: 'managed_command',
    startedAt: execution.startedAt,
    cancelability: ownedByViewer
      ? { state: 'cancelable', target: { kind: 'managed_command', taskId: execution.taskId } }
      : { state: 'not_cancelable', reason: 'foreign_principal' },
  };
}

async function requireAccessibleThread(
  request: FastifyRequest<{ Params: { threadId: string } }>,
  reply: FastifyReply,
  threadStore: IThreadStore,
  action: 'read' | 'cancel',
): Promise<{ userId: string; thread: Thread; visibleThreads?: readonly Thread[] } | null> {
  const userId = resolveUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Identity required', code: 'AUTH_REQUIRED' });
    return null;
  }
  const thread = await threadStore.get(request.params.threadId);
  const decision = await resolveThreadAccess({
    threadStore,
    thread,
    userId,
    request: { resource: 'executions', action },
  });
  if (decision.status !== 200) {
    reply.status(decision.status).send(threadAccessDeniedBody(decision));
    return null;
  }
  if (!thread) throw new Error('Thread access policy allowed a missing thread');
  return {
    userId,
    thread,
    ...(decision.basis === 'user_index' ? { visibleThreads: decision.visibleThreads } : {}),
  };
}

/**
 * F297 AC-D3：用稀疏候选收窄 project scan 的定性面。
 *
 * **降级方向与 Sidebar 相反，这是刻意的。** 两处漏报的后果不同：
 * - Sidebar 漏报 → 该行显示 `idle`（少显示，用户无损）⇒ 知识不完整时 **fail-closed**。
 * - 本列表漏报 → 正在跑的执行**不出现在可取消列表里**，用户想停也停不掉（功能损坏）
 *   ⇒ 知识不完整时 **fail-open**：退回全量扫描，宁可多花往返也不能少一条。
 *
 * 因此只有快照**完整**时才收窄；未接线、读失败、`complete=false` 一律走全量。
 */
async function narrowLiveScanTargets(
  threads: readonly Thread[],
  userId: string,
  request: FastifyRequest,
  deps: ActiveExecutionRouteDeps,
): Promise<readonly Thread[]> {
  if (!deps.buildLiveCandidateSnapshot) return threads;
  let snapshot: { readonly threadIds: readonly string[]; readonly complete: boolean };
  try {
    snapshot = await deps.buildLiveCandidateSnapshot(userId, request);
  } catch {
    return threads; // 读失败 = 未知 ⇒ 不敢收窄
  }
  if (!snapshot.complete) return threads; // 候选可能漏报 ⇒ 不敢收窄
  const candidates = new Set(snapshot.threadIds);
  return threads.filter((thread) => candidates.has(thread.id));
}

async function buildActiveExecutionList(
  currentThread: Thread,
  userId: string,
  request: FastifyRequest,
  deps: ActiveExecutionRouteDeps,
  admittedVisibleThreads?: readonly Thread[],
): Promise<ActiveExecutionListResponse> {
  const visibleThreads =
    admittedVisibleThreads ?? (await deps.threadStore.listByProject(userId, currentThread.projectPath));
  const threads = visibleThreads.filter(
    (thread) => thread.projectPath === currentThread.projectPath && canProjectThread(thread, userId),
  );
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const scanTargets = await narrowLiveScanTargets(threads, userId, request, deps);
  const liveGroups = await Promise.all(
    scanTargets.map(async (thread) => ({
      thread,
      candidates: await deps.resolveLiveExecutions(thread.id, userId, request),
    })),
  );
  const executions = liveGroups.flatMap(({ thread, candidates }) =>
    candidates.map((candidate) => projectLiveExecution(thread, userId, candidate, deps.invocationTracker)),
  );

  for (const execution of listManagedCommandExecutions(deps.dynamicTaskStore?.getAll() ?? [])) {
    const managedExecution = projectManagedCommandExecution(execution, userId, threadById);
    if (managedExecution) executions.push(managedExecution);
  }
  return { projectPath: currentThread.projectPath, executions: sortExecutions(executions) };
}

export function registerActiveExecutionRoutes(app: FastifyInstance, deps: ActiveExecutionRouteDeps): void {
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/executions/active', async (request, reply) => {
    const access = await requireAccessibleThread(request, reply, deps.threadStore, 'read');
    if (!access) return;
    return buildActiveExecutionList(access.thread, access.userId, request, deps, access.visibleThreads);
  });

  app.post<{
    Params: { threadId: string; executionId: string };
    Body: { catId: string };
  }>('/api/threads/:threadId/executions/live/:executionId/cancel', async (request, reply) => {
    const access = await requireAccessibleThread(request, reply, deps.threadStore, 'cancel');
    if (!access) return;
    const parsed = cancelLiveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', code: 'INVALID_REQUEST' };
    }

    const { threadId, executionId } = request.params;
    const { catId } = parsed.data;
    const liveCandidates = await deps.resolveLiveExecutions(threadId, access.userId, request);
    const candidate = liveCandidates.find(
      (item) =>
        item.catId === catId &&
        item.executionId === executionId &&
        canControlLiveExecution(access.thread, access.userId, item),
    );
    if (!candidate) {
      if (deps.isLiveExecutionControlPlaneComplete && !(await deps.isLiveExecutionControlPlaneComplete(request))) {
        reply.status(503);
        return {
          error: '执行控制面暂时不可用，请重试',
          code: 'EXECUTION_CONTROL_UNAVAILABLE',
        };
      }
      const replacement = liveCandidates.find(
        (item) => item.catId === catId && canControlLiveExecution(access.thread, access.userId, item),
      );
      reply.status(409);
      return {
        error: replacement ? '该执行已被更新的回合替代' : '该执行已结束或无法取消',
        code: replacement ? 'EXECUTION_REPLACED' : 'EXECUTION_NOT_ACTIVE',
      };
    }

    const result = await deps.cancelExactLiveInvocation({
      threadId,
      userId: access.userId,
      catId,
      executionId,
      candidate,
      request,
    });
    if (result.controlPlaneUnavailable) {
      reply.status(503);
      return {
        error: '执行控制面暂时不可用，请重试',
        code: 'EXECUTION_CONTROL_UNAVAILABLE',
      };
    }
    return { ok: true, cancelled: result.cancelled };
  });
}
