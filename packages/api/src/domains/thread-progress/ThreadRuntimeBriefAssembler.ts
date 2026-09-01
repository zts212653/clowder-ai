import type {
  SessionRecord,
  ThreadProgressReceiptV1,
  ThreadRuntimeBriefV1,
  ThreadRuntimeCurrentExecution,
  ThreadRuntimeSessionSummary,
} from '@cat-cafe/shared';
import type { TaskProgressSnapshot, TaskProgressStore } from '../cats/services/agents/invocation/TaskProgressStore.js';
import type { ISessionChainStore } from '../cats/services/stores/ports/SessionChainStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { ThreadBriefLiveExecution } from './ThreadBriefAssembler.js';
import type { IThreadProgressReceiptStore } from './ThreadProgressReceiptStore.js';

export interface ThreadRuntimeBriefAssemblerDeps {
  readonly receiptStore: Pick<IThreadProgressReceiptStore, 'listByThread'>;
  readonly taskStore: Pick<ITaskStore, 'listByThread'>;
  readonly taskProgressStore: Pick<TaskProgressStore, 'getThreadSnapshots'>;
  readonly sessionChainStore: Pick<ISessionChainStore, 'getChainByThread'>;
  readonly readLiveExecutions: (threadId: string, ownerUserId: string) => Promise<readonly ThreadBriefLiveExecution[]>;
  readonly now?: () => number;
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

export class ThreadRuntimeBriefAssembler {
  constructor(private readonly deps: ThreadRuntimeBriefAssemblerDeps) {}

  async assemble(thread: Thread, ownerUserId: string): Promise<ThreadRuntimeBriefV1> {
    const [live, progress, sessions, receipts, tasks] = await Promise.all([
      settle(() => this.deps.readLiveExecutions(thread.id, ownerUserId)),
      settle<Record<string, TaskProgressSnapshot>>(() => this.deps.taskProgressStore.getThreadSnapshots(thread.id)),
      settle(() => Promise.resolve(this.deps.sessionChainStore.getChainByThread(thread.id))),
      settle(() => this.deps.receiptStore.listByThread(ownerUserId, thread.id, { limit: 1 })),
      settle(() => Promise.resolve(this.deps.taskStore.listByThread(thread.id))),
    ]);
    const latestReceipt = receipts.ok ? receipts.value[0] : undefined;
    const metadata = thread.threadMetadata;

    return {
      v: 1,
      thread: { id: thread.id, title: thread.title?.trim() || '未命名会话' },
      availability: deriveAvailability({ live, progress, sessions, receipts, tasks }),
      currentExecutions: buildCurrentExecutions(live, progress),
      recentSessions: buildRecentSessions(sessions, ownerUserId),
      latestProgress: latestReceipt ? toReceiptSummary(latestReceipt) : null,
      nextStep: latestReceipt?.nextStep ?? null,
      openWorkTaskCount: tasks.ok ? countOpenWorkTasks(tasks.value, ownerUserId) : 0,
      anchors: {
        worktrees: metadata?.worktrees ?? [],
        prs: metadata?.prs ?? [],
        issues: metadata?.issues ?? [],
        features: metadata?.features ?? [],
      },
      generatedAt: this.deps.now?.() ?? Date.now(),
    };
  }
}

function buildCurrentExecutions(
  live: Settled<readonly ThreadBriefLiveExecution[]>,
  progress: Settled<Record<string, TaskProgressSnapshot>>,
): ThreadRuntimeCurrentExecution[] {
  if (!live.ok) return [];
  const snapshots = progress.ok ? progress.value : {};
  return live.value.map((execution) => {
    const snapshot = snapshots[execution.catId];
    const plan =
      execution.turnInvocationId && snapshot?.lastInvocationId === execution.turnInvocationId
        ? {
            status: snapshot.status,
            updatedAt: snapshot.updatedAt,
            tasks: snapshot.tasks.map(({ id, subject, status, activeForm }) => ({
              id,
              subject,
              status,
              ...(activeForm ? { activeForm } : {}),
            })),
          }
        : undefined;
    return {
      catId: execution.catId,
      startedAt: execution.startedAt,
      confidence: execution.degraded ? 'degraded' : 'confirmed',
      ...(plan ? { plan } : {}),
    };
  });
}

function buildRecentSessions(sessions: Settled<SessionRecord[]>, ownerUserId: string): ThreadRuntimeSessionSummary[] {
  if (!sessions.ok) return [];
  return sessions.value
    .filter((session) => session.userId === ownerUserId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.seq - left.seq)
    .slice(0, 3)
    .map(toSessionSummary);
}

function toSessionSummary(session: SessionRecord): ThreadRuntimeSessionSummary {
  return {
    sessionId: session.id,
    ...(session.cliSessionId ? { cliSessionId: session.cliSessionId } : {}),
    catId: session.catId,
    status: session.status,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    ...(session.sealedAt ? { sealedAt: session.sealedAt } : {}),
    ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
    ...(session.lastUsage ? { usage: session.lastUsage } : {}),
    ...(session.contextHealth
      ? {
          contextHealth: {
            fillRatio: session.contextHealth.fillRatio,
            source: session.contextHealth.source,
            measuredAt: session.contextHealth.measuredAt,
          },
        }
      : {}),
  };
}

function toReceiptSummary(receipt: ThreadProgressReceiptV1) {
  return {
    id: receipt.id,
    kind: receipt.kind,
    headline: receipt.headline,
    ...(receipt.detail ? { detail: receipt.detail } : {}),
    ...(receipt.nextStep ? { nextStep: receipt.nextStep } : {}),
    actor: receipt.actor,
    occurredAt: receipt.occurredAt,
  };
}

function countOpenWorkTasks(tasks: Awaited<ReturnType<ITaskStore['listByThread']>>, ownerUserId: string): number {
  return tasks.filter(
    (task) => task.kind === 'work' && task.status !== 'done' && (!task.userId || task.userId === ownerUserId),
  ).length;
}

function deriveAvailability(reads: Record<string, Settled<unknown>>) {
  const values = Object.values(reads);
  if (values.every((value) => value.ok)) return 'ok' as const;
  return values.some((value) => value.ok) ? ('partial' as const) : ('unavailable' as const);
}
