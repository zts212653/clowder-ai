/**
 * F233 Phase A — 数据获取层（薄 IO，KD-4 全程只读）
 *
 * 从 5 个现存数据源只读投影出 DutyBriefingInput（喂给纯函数 aggregateDutyBriefing）。
 * 每个 collector 独立 try/catch（safeCollect）：单源失败 → degradedSources 标记 + 该区空，
 * 整卡照发（plan 对抗场景 3）。所有 store 方法均为读操作 → AC-A5 只读。
 *
 * 数据源可读路径见 docs/plans/2026-06-12-f233-phase-a-duty-briefing.md 附录 Task 0。
 */

import type { RuntimeEvalSnapshot } from '../../../../infrastructure/harness-eval/f167-eval.js';
import type { DynamicTaskStore } from '../../../../infrastructure/scheduler/DynamicTaskStore.js';
import type { IDraftStore } from '../stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { ITaskStore } from '../stores/ports/TaskStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import { isSystemUserMessage } from '../stores/visibility.js';
import type {
  AggregatorExpiredHold,
  AggregatorMentionCandidate,
  AggregatorTask,
  AggregatorVoidPass,
  AggregatorZombie,
  DutyBriefingInput,
} from './BallCustodyAggregator.js';
import {
  DEAD_BALL_FRESH_DRAFT_WINDOW_MS,
  DEAD_BALL_ZOMBIE_GRACE_MS,
  MENTION_SCAN_ACTIVE_WINDOW_MS,
  TITLE_MAX,
} from './constants.js';

const HOLD_BALL_ID_PREFIX = 'hold-ball-';
const HOLD_BALL_CREATED_BY_PREFIX = 'hold-ball:';

export interface CollectDutyBriefingDeps {
  taskStore: Pick<ITaskStore, 'listByKind'>;
  // 完整接口（非 Pick）：scanAll 是 optional（仅 Redis 提供），Pick 会成 weak type
  // 致 in-memory store（无 scanAll）无法赋值；collectZombies 内部已 runtime check scanAll 缺失。
  invocationRecordStore: IInvocationRecordStore;
  draftStore: Pick<IDraftStore, 'getByThread'>;
  dynamicTaskStore: Pick<DynamicTaskStore, 'getAll'>;
  threadStore: Pick<IThreadStore, 'list'>;
  messageStore: Pick<IMessageStore, 'getByThread' | 'getByThreadAfter'>;
  /** 可降级：拿不到 snapshot → voidPasses 空 + degradedSources 标记（Task 0 决议） */
  f167SnapshotProvider?: () => RuntimeEvalSnapshot | null | Promise<RuntimeEvalSnapshot | null>;
  userId: string;
  now: number;
  bindingStatus: 'bound' | 'degraded';
}

/** 单 collector 失败不崩整卡：catch → 记 degradedSources + 返回 fallback（对抗场景 3）。 */
async function safeCollect<T>(
  source: string,
  fn: () => Promise<T> | T,
  fallback: T,
  degradedSources: string[],
): Promise<T> {
  try {
    return await fn();
  } catch {
    degradedSources.push(source);
    return fallback;
  }
}

export async function collectTasks(
  taskStore: Pick<ITaskStore, 'listByKind'>,
  userId: string,
): Promise<AggregatorTask[]> {
  const tasks = await taskStore.listByKind('work');
  return tasks
    .filter((t) => t.userId === userId || (t.userId == null && userId === 'default-user'))
    .map((t) => ({
      id: t.id,
      title: t.title,
      ownerCatId: t.ownerCatId,
      status: t.status,
      why: t.why,
      updatedAt: t.updatedAt,
      threadId: t.threadId,
    }));
}

function extractHoldCatId(createdBy: string): string | null {
  return createdBy.startsWith(HOLD_BALL_CREATED_BY_PREFIX) ? createdBy.slice(HOLD_BALL_CREATED_BY_PREFIX.length) : null;
}

/** 返回 { expired: 过期 hold（→死球区）, activeCount: 活跃 hold 数（→healthy） } */
async function collectHolds(
  dynamicTaskStore: Pick<DynamicTaskStore, 'getAll'>,
  threadStore: Pick<IThreadStore, 'list'>,
  userId: string,
  now: number,
): Promise<{ expired: AggregatorExpiredHold[]; activeCount: number }> {
  const expired: AggregatorExpiredHold[] = [];
  let activeCount = 0;
  const allowedThreadIds = new Set((await threadStore.list(userId)).map((thread) => thread.id));
  for (const def of dynamicTaskStore.getAll()) {
    const isHold =
      def.enabled &&
      def.id.startsWith(HOLD_BALL_ID_PREFIX) &&
      def.templateId === 'reminder' &&
      def.createdBy.startsWith(HOLD_BALL_CREATED_BY_PREFIX);
    if (!isHold || def.trigger.type !== 'once') continue;
    if (!def.deliveryThreadId || !allowedThreadIds.has(def.deliveryThreadId)) continue;
    if (def.trigger.fireAt < now) {
      expired.push({
        threadId: def.deliveryThreadId,
        catId: extractHoldCatId(def.createdBy),
        fireAt: def.trigger.fireAt,
        message: typeof def.params.message === 'string' ? def.params.message : undefined,
      });
    } else {
      activeCount += 1;
    }
  }
  return { expired, activeCount };
}

/**
 * invocation 死球：scanAll（Redis-only）filter running，对每个查 draft freshness 自判 zombie。
 * 复用 F194 判定（record.updatedAt 非心跳；draft.updatedAt 才是）；KD-4 只读，绝不调 reconcileZombies。
 * 返回 { zombies, runningCount }（runningCount-zombies 计入 healthy）。
 */
export async function collectZombies(
  invocationRecordStore: Pick<IInvocationRecordStore, 'scanAll'>,
  draftStore: Pick<IDraftStore, 'getByThread'>,
  userId: string,
  now: number,
): Promise<{
  zombies: AggregatorZombie[];
  runningCount: number;
  runningZombieCount: number;
  degraded: boolean;
  oldestHealthyAgeMs: number;
}> {
  if (!invocationRecordStore.scanAll) {
    return { zombies: [], runningCount: 0, runningZombieCount: 0, degraded: true, oldestHealthyAgeMs: 0 };
  }
  const records = await invocationRecordStore.scanAll();
  const ownerRecords = records.filter((r) => r.userId === userId);
  const failed = ownerRecords.filter((r) => r.status === 'failed');
  const running = ownerRecords.filter((r) => r.status === 'running');
  const draftCache = new Map<string, Awaited<ReturnType<IDraftStore['getByThread']>>>();
  const zombies: AggregatorZombie[] = failed.map((r) => ({
    invocationId: r.id,
    threadId: r.threadId,
    catId: (r.targetCats[0] as string | undefined) ?? null,
    recordUpdatedAt: r.updatedAt,
    detail: r.error ?? 'invocation_failed',
  }));
  let oldestHealthyAgeMs = 0;
  let runningZombieCount = 0;
  for (const r of running) {
    const key = `${r.userId}\\0${r.threadId}`;
    let drafts = draftCache.get(key);
    if (!drafts) {
      drafts = await draftStore.getByThread(r.userId, r.threadId);
      draftCache.set(key, drafts);
    }
    const draft = drafts.find((d) => d.invocationId === r.id);
    const hasFreshDraft = draft != null && now - draft.updatedAt <= DEAD_BALL_FRESH_DRAFT_WINDOW_MS;
    if (!hasFreshDraft && now - r.updatedAt > DEAD_BALL_ZOMBIE_GRACE_MS) {
      zombies.push({
        invocationId: r.id,
        threadId: r.threadId,
        catId: (r.targetCats[0] as string | undefined) ?? null,
        recordUpdatedAt: r.updatedAt,
        detail: 'no_tracker_no_fresh_draft',
      });
      runningZombieCount += 1;
    } else {
      const heartbeatAt = hasFreshDraft ? draft.updatedAt : r.updatedAt;
      oldestHealthyAgeMs = Math.max(oldestHealthyAgeMs, now - heartbeatAt);
    }
  }
  return { zombies, runningCount: running.length, runningZombieCount, degraded: false, oldestHealthyAgeMs };
}

function collectVoidPasses(snapshot: RuntimeEvalSnapshot | null): AggregatorVoidPass[] {
  if (!snapshot) return [];
  const c2 = snapshot.components.find((c) => c.componentId === 'C2');
  const samples = c2?.frictionSamples['c2.verdict_without_pass_count'] ?? [];
  return samples.map((s) => ({
    trigger: s.trigger,
    firedAtMs: Date.parse(s.firedAt),
    catId: s.agentId ?? null,
  }));
}

function deriveTitle(content: string, threadTitle: string | null): string {
  const firstLine = content
    .split('\n')
    .find((l) => l.trim().length > 0)
    ?.trim();
  // thread 标题优先（识别球在哪个上下文），消息内容是 fallback（无标题 thread）
  const raw = threadTitle || firstLine || '(无标题)';
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX - 1)}…` : raw;
}

/**
 * mention 启发式（heuristic 候选）：扫近期活跃 thread 尾部消息，找"猫 @co-creator 后 operator 无回应"。
 * 只产候选——消息模型无 handoff/fyi intent（gpt52 R1）。
 */
async function collectMentionCandidates(
  threadStore: Pick<IThreadStore, 'list'>,
  messageStore: Pick<IMessageStore, 'getByThread' | 'getByThreadAfter'>,
  userId: string,
  now: number,
): Promise<AggregatorMentionCandidate[]> {
  const threads = await threadStore.list(userId);
  const candidates: AggregatorMentionCandidate[] = [];
  for (const thread of threads) {
    if (now - thread.lastActiveAt > MENTION_SCAN_ACTIVE_WINDOW_MS) continue;
    const tail = await messageStore.getByThread(thread.id, 1, userId);
    const last = tail[tail.length - 1];
    if (!last || !last.mentionsUser || last.catId == null) continue;
    const after = await messageStore.getByThreadAfter(thread.id, last.id, undefined, userId);
    if (after.some((m) => m.catId == null && !isSystemUserMessage(m))) continue; // 真正的 operator 已回应 → 球不在 operator 手上
    candidates.push({
      threadId: thread.id,
      messageId: last.id,
      catId: last.catId,
      title: deriveTitle(last.content, thread.title),
      timestamp: last.deliveredAt ?? last.timestamp,
    });
  }
  return candidates;
}

function oldestHeartbeat(tasks: AggregatorTask[], now: number): number {
  const doing = tasks.filter((t) => t.status === 'doing');
  if (doing.length === 0) return 0;
  const oldest = Math.min(...doing.map((t) => t.updatedAt));
  return now - oldest;
}

/** 整合：5 源只读投影 → DutyBriefingInput。每源独立降级，整卡照发。 */
export async function collectDutyBriefingInput(deps: CollectDutyBriefingDeps): Promise<DutyBriefingInput> {
  const { now, userId } = deps;
  const degradedSources: string[] = [];

  const tasks = await safeCollect('tasks', () => collectTasks(deps.taskStore, userId), [], degradedSources);
  const holds = await safeCollect(
    'hold_ball',
    () => collectHolds(deps.dynamicTaskStore, deps.threadStore, userId, now),
    { expired: [], activeCount: 0 },
    degradedSources,
  );
  const invocation = await safeCollect(
    'invocation',
    () => collectZombies(deps.invocationRecordStore, deps.draftStore, userId, now),
    { zombies: [], runningCount: 0, runningZombieCount: 0, degraded: true, oldestHealthyAgeMs: 0 },
    degradedSources,
  );
  if (invocation.degraded && !degradedSources.includes('invocation')) degradedSources.push('invocation');
  const voidPassResult = await safeCollect(
    'f167_telemetry',
    async () => {
      if (!deps.f167SnapshotProvider) return { entries: [], degraded: true };
      const snapshot = await deps.f167SnapshotProvider();
      if (!snapshot) return { entries: [], degraded: true };
      return { entries: collectVoidPasses(snapshot), degraded: false };
    },
    { entries: [], degraded: true },
    degradedSources,
  );
  if (voidPassResult.degraded && !degradedSources.includes('f167_telemetry')) degradedSources.push('f167_telemetry');
  const mentionCandidates = await safeCollect(
    'mention',
    () => collectMentionCandidates(deps.threadStore, deps.messageStore, userId, now),
    [],
    degradedSources,
  );

  // 构建 threadId→title 映射：zombie/hold 条目需要 thread 名做标题（而非纯 catId）
  const threadTitles: Record<string, string> = {};
  try {
    const threads = await deps.threadStore.list(userId);
    for (const t of threads) {
      if (t.title) threadTitles[t.id] = t.title;
    }
  } catch {
    // thread list 失败不阻塞简报——zombie/hold 标题退化到旧逻辑（catId 标题）
  }

  const doingCount = tasks.filter((t) => t.status === 'doing').length;
  const healthyInvocations = Math.max(0, invocation.runningCount - invocation.runningZombieCount);
  const activeCount = doingCount + holds.activeCount + healthyInvocations;
  const oldestTaskHeartbeatMs = oldestHeartbeat(tasks, now);

  return {
    tasks,
    zombies: invocation.zombies,
    expiredHolds: holds.expired,
    voidPasses: voidPassResult.entries,
    mentionCandidates,
    threadTitles,
    activeCount,
    oldestHeartbeatMs: Math.max(oldestTaskHeartbeatMs, invocation.oldestHealthyAgeMs),
    bindingStatus: deps.bindingStatus,
    degradedSources,
    now,
  };
}
