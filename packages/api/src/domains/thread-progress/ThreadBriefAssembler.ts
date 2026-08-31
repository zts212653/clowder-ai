import type {
  ThreadBriefAttentionItem,
  ThreadBriefAvailability,
  ThreadBriefCurrentExecution,
  ThreadBriefPresentationState,
  ThreadBriefV1,
  ThreadBriefWaitItem,
  ThreadProgressReceiptSummary,
  ThreadProgressReceiptV1,
  WorkflowSop,
} from '@cat-cafe/shared';
import type { TaskProgressSnapshot, TaskProgressStore } from '../cats/services/agents/invocation/TaskProgressStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../cats/services/stores/ports/WorkflowSopStore.js';
import type { IThreadProgressReceiptStore } from './ThreadProgressReceiptStore.js';

export interface ThreadBriefLiveExecution {
  readonly catId: string;
  readonly startedAt: number;
  readonly turnInvocationId?: string;
  readonly degraded: boolean;
}

export interface ThreadBriefAssemblerDeps {
  readonly receiptStore: IThreadProgressReceiptStore;
  readonly taskStore: Pick<ITaskStore, 'listByThread'>;
  readonly taskProgressStore?: Pick<TaskProgressStore, 'getThreadSnapshots'>;
  readonly workflowSopStore?: Pick<IWorkflowSopStore, 'get'>;
  readonly readLiveExecutions: (threadId: string, ownerUserId: string) => Promise<readonly ThreadBriefLiveExecution[]>;
  readonly readAttention: (ownerUserId: string, threadId: string) => Promise<readonly ThreadBriefAttentionItem[]>;
  readonly readWaits: (ownerUserId: string, threadId: string) => Promise<readonly ThreadBriefWaitItem[]>;
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

export class ThreadBriefAssembler {
  constructor(private readonly deps: ThreadBriefAssemblerDeps) {}

  async assemble(thread: Thread, ownerUserId: string): Promise<ThreadBriefV1> {
    const [live, attention, waits, receipts, tasks, progress, workflow] = await Promise.all([
      settle(() => this.deps.readLiveExecutions(thread.id, ownerUserId)),
      settle(() => this.deps.readAttention(ownerUserId, thread.id)),
      settle(() => this.deps.readWaits(ownerUserId, thread.id)),
      settle(() => this.deps.receiptStore.listByThread(ownerUserId, thread.id, { limit: 3 })),
      settle(() => Promise.resolve(this.deps.taskStore.listByThread(thread.id))),
      settle<Record<string, TaskProgressSnapshot>>(
        () => this.deps.taskProgressStore?.getThreadSnapshots(thread.id) ?? Promise.resolve({}),
      ),
      settle(() => readWorkflow(this.deps, thread)),
    ]);

    const currentExecutions = buildCurrentExecutions(live, progress);
    const attentionItems = attention.ok ? [...attention.value] : [];
    const waitItems = waits.ok ? [...waits.value] : [];
    const receiptItems = receipts.ok ? receipts.value : [];
    const workflowGoal = workflow.ok ? workflow.value?.resumeCapsule.goal.trim() : '';
    const title = thread.title?.trim() || '未命名会话';
    const headReceipt = receiptItems[0];

    return {
      v: 1,
      thread: { id: thread.id, title },
      contextHeading: workflowGoal ? { label: '目标', text: workflowGoal } : { label: '会话', text: title },
      availability: deriveAvailability({ live, attention, waits, receipts, tasks, progress, workflow }),
      presentationState: derivePresentationState({ live, attention, waits, currentExecutions }),
      currentExecutions,
      attention: attentionItems,
      waits: waitItems,
      recentProgress: receiptItems.map(toReceiptSummary),
      lastProgressAt: headReceipt?.occurredAt ?? null,
      nextStep: headReceipt?.nextStep ?? null,
      openWorkTaskCount: tasks.ok ? countOpenWorkTasks(tasks.value, ownerUserId) : 0,
      hasHistory: receiptItems.length > 0,
      generatedAt: this.deps.now?.() ?? Date.now(),
    };
  }
}

function readWorkflow(deps: ThreadBriefAssemblerDeps, thread: Thread): Promise<WorkflowSop | null> {
  if (!thread.backlogItemId || !deps.workflowSopStore) return Promise.resolve(null);
  return deps.workflowSopStore.get(thread.backlogItemId);
}

function buildCurrentExecutions(
  live: Settled<readonly ThreadBriefLiveExecution[]>,
  progress: Settled<Record<string, TaskProgressSnapshot>>,
): ThreadBriefCurrentExecution[] {
  if (!live.ok) return [];
  const progressByCat = progress.ok ? progress.value : {};
  return live.value.map((execution) => {
    const action = currentAction(execution, progressByCat[execution.catId]);
    return {
      catId: execution.catId,
      startedAt: execution.startedAt,
      confidence: execution.degraded ? 'degraded' : 'confirmed',
      ...(action ? { action } : {}),
    };
  });
}

function currentAction(execution: ThreadBriefLiveExecution, snapshot?: TaskProgressSnapshot): string | undefined {
  if (!execution.turnInvocationId || snapshot?.lastInvocationId !== execution.turnInvocationId) return undefined;
  const activeTask = snapshot.tasks.find((task) => task.status === 'in_progress');
  return activeTask?.activeForm ?? activeTask?.subject;
}

function toReceiptSummary(receipt: ThreadProgressReceiptV1): ThreadProgressReceiptSummary {
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

interface CurrentStateReads {
  readonly live: Settled<readonly ThreadBriefLiveExecution[]>;
  readonly attention: Settled<readonly ThreadBriefAttentionItem[]>;
  readonly waits: Settled<readonly ThreadBriefWaitItem[]>;
  readonly currentExecutions: readonly ThreadBriefCurrentExecution[];
}

function derivePresentationState(reads: CurrentStateReads): ThreadBriefPresentationState {
  if (reads.attention.ok && reads.attention.value.length > 0) return 'needs_user';
  if (!reads.live.ok || !reads.attention.ok || !reads.waits.ok) return 'unknown';
  if (reads.currentExecutions.some((execution) => execution.confidence === 'confirmed')) return 'running';
  if (reads.currentExecutions.some((execution) => execution.confidence === 'degraded')) return 'unknown';
  return reads.waits.value.length > 0 ? 'waiting_external' : 'idle';
}

function deriveAvailability(reads: {
  readonly live: Settled<unknown>;
  readonly attention: Settled<unknown>;
  readonly waits: Settled<unknown>;
  readonly receipts: Settled<unknown>;
  readonly tasks: Settled<unknown>;
  readonly progress: Settled<unknown>;
  readonly workflow: Settled<unknown>;
}): ThreadBriefAvailability {
  if (!reads.live.ok && !reads.attention.ok && !reads.waits.ok) return 'unavailable';
  return Object.values(reads).every((read) => read.ok) ? 'ok' : 'partial';
}

function countOpenWorkTasks(tasks: Awaited<ReturnType<ITaskStore['listByThread']>>, ownerUserId: string): number {
  return tasks.filter(
    (task) => task.kind === 'work' && task.status !== 'done' && (!task.userId || task.userId === ownerUserId),
  ).length;
}
