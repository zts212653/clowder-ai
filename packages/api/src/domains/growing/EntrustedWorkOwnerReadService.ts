import {
  type EntrustedWorkOwnerReadV1,
  type EntrustedWorkTaskExecutionV1,
  entrustedWorkOwnerReadV1Schema,
  type ProducerAttentionCoverageV1,
  type ProducerAttentionReceiptV1,
  type TaskItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { composeEntrustedWorkBrief } from './EntrustedWorkBriefComposer.js';
import {
  projectEntrustedWorkTimeRefs,
  projectTaskTerminal,
  readOwnerTaskExecution,
  sameCompletionArtifact,
  taskIdFromEntrustedWorkSubjectRef,
} from './EntrustedWorkOwnerReadProjection.js';
import type { NeedsMeProducerCatalog } from './NeedsMeProducerCatalog.js';
import type { PreparedArtifactReader } from './ports/PreparedArtifactReader.js';

export type { PreparedArtifactReader, PreparedArtifactReadInput } from './ports/PreparedArtifactReader.js';

const boundedRef = z.string().trim().min(1).max(1_000);

const ownerReadInputSchema = z
  .object({
    taskId: boundedRef,
    observedRevision: z.number().int().positive().optional(),
    includeCompleted: z.boolean().optional(),
    includeCancelled: z.boolean().optional(),
    viewer: z.discriminatedUnion('surface', [
      z.object({ surface: z.literal('human'), userId: boundedRef }).strict(),
      z
        .object({
          surface: z.literal('cat'),
          userId: boundedRef,
          threadId: boundedRef,
          catId: boundedRef,
        })
        .strict(),
    ]),
  })
  .strict();

export type EntrustedWorkOwnerReadErrorCode =
  | 'OWNER_READ_NOT_FOUND'
  | 'OWNER_READ_FORBIDDEN'
  | 'OWNER_READ_CONTRACT_MISSING'
  | 'OWNER_READ_TERMINAL'
  | 'OWNER_READ_FUTURE_REVISION'
  | 'OWNER_READ_CONTRACT_INVALID';

export class EntrustedWorkOwnerReadError extends Error {
  constructor(
    readonly code: EntrustedWorkOwnerReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntrustedWorkOwnerReadError';
  }
}

type EntrustedWorkContract = NonNullable<TaskItem['entrustedWork']>;

function assertTerminalReadAllowed(
  task: TaskItem,
  entrusted: EntrustedWorkContract,
  input: z.output<typeof ownerReadInputSchema>,
): boolean {
  const taskTerminal = task.status === 'done';
  const contractTerminal = entrusted.closure.state !== 'open';
  if (taskTerminal !== contractTerminal) {
    throw new EntrustedWorkOwnerReadError(
      'OWNER_READ_CONTRACT_INVALID',
      'Task status and entrusted-work terminal state disagree',
    );
  }
  if (!taskTerminal) return false;
  if (entrusted.closure.state === 'satisfied' && input.includeCompleted) return true;
  if ((entrusted.closure.state === 'cancelled' || entrusted.closure.state === 'abandoned') && input.includeCancelled) {
    return false;
  }
  throw new EntrustedWorkOwnerReadError('OWNER_READ_TERMINAL', 'Entrusted work is terminal');
}

function currentAttentionReceipts(input: {
  readonly isCurrent: boolean;
  readonly entrusted: EntrustedWorkContract;
  readonly subjectRef: string;
  readonly producerReceipts: readonly ProducerAttentionReceiptV1[];
}): ProducerAttentionReceiptV1[] {
  if (!input.isCurrent || input.entrusted.closure.state !== 'open') return [];
  return input.producerReceipts.filter(
    (receipt) =>
      receipt.taskRef.subjectRef === input.subjectRef && receipt.taskRef.observedRevision === input.entrusted.revision,
  );
}

export interface EntrustedWorkOwnerReadServiceDeps {
  readonly tasks: Pick<ITaskStore, 'get' | 'listByKind'>;
  readonly producerCatalog: NeedsMeProducerCatalog;
  readonly artifactReader?: PreparedArtifactReader;
  readonly taskExecution?: { read(task: TaskItem): Promise<EntrustedWorkTaskExecutionV1> };
}

export type EntrustedWorkOwnerReadInput = z.input<typeof ownerReadInputSchema>;

export interface EntrustedWorkOwnerReadCollectionV1 {
  readonly ownerReads: EntrustedWorkOwnerReadV1[];
  readonly coverage: ProducerAttentionCoverageV1;
}

const completeAttentionRead = {
  receipts: [] as ProducerAttentionReceiptV1[],
  coverage: { state: 'complete' as const },
};

export class EntrustedWorkOwnerReadService {
  constructor(private readonly deps: EntrustedWorkOwnerReadServiceDeps) {}

  async read(rawInput: EntrustedWorkOwnerReadInput): Promise<EntrustedWorkOwnerReadV1> {
    const input = ownerReadInputSchema.parse(rawInput);
    const task = await this.deps.tasks.get(input.taskId);
    if (!task) throw new EntrustedWorkOwnerReadError('OWNER_READ_NOT_FOUND', 'Entrusted-work Task not found');
    this.assertViewer(task, input.viewer);
    const attention =
      task.entrustedWork?.closure.state !== 'open'
        ? completeAttentionRead
        : await this.deps.producerCatalog.readCurrentReceipts(input.viewer.userId);
    return this.compose(task, input, attention.receipts, this.deps.artifactReader, attention.coverage);
  }

  async listForOwner(
    userId: string,
    view: 'active' | 'completed' | 'cancelled' = 'active',
  ): Promise<EntrustedWorkOwnerReadV1[]> {
    return (await this.readForOwner(userId, view)).ownerReads;
  }

  async readForOwner(
    userId: string,
    view: 'active' | 'completed' | 'cancelled' = 'active',
  ): Promise<EntrustedWorkOwnerReadCollectionV1> {
    const ownerUserId = boundedRef.parse(userId);
    const attention =
      view === 'active' ? await this.deps.producerCatalog.readCurrentReceipts(ownerUserId) : completeAttentionRead;
    const tasks = await this.deps.tasks.listByKind('work');
    const currentTasks = tasks.filter(
      (task) =>
        task.userId === ownerUserId &&
        (view === 'completed'
          ? task.status === 'done' && task.entrustedWork?.closure.state === 'satisfied'
          : view === 'cancelled'
            ? task.status === 'done' &&
              (task.entrustedWork?.closure.state === 'cancelled' || task.entrustedWork?.closure.state === 'abandoned')
            : task.status !== 'done' && task.entrustedWork?.closure.state === 'open'),
    );
    const artifactReader = this.deps.artifactReader?.createReadScope?.() ?? this.deps.artifactReader;
    const ownerReads: EntrustedWorkOwnerReadV1[] = [];
    // One owner scan at a time; repeated work in the same thread reuses this request's index.
    for (const task of currentTasks) {
      ownerReads.push(
        await this.compose(
          task,
          {
            taskId: task.id,
            includeCompleted: view === 'completed',
            includeCancelled: view === 'cancelled',
            viewer: { surface: 'human', userId: ownerUserId },
          },
          attention.receipts,
          artifactReader,
          attention.coverage,
        ),
      );
    }
    return { ownerReads, coverage: attention.coverage };
  }

  async listNeedsMeForOwner(userId: string): Promise<EntrustedWorkOwnerReadV1[]> {
    return (await this.readNeedsMeForOwner(userId)).ownerReads;
  }

  async readNeedsMeForOwner(userId: string): Promise<EntrustedWorkOwnerReadCollectionV1> {
    const ownerUserId = boundedRef.parse(userId);
    const attention = await this.deps.producerCatalog.readCurrentReceipts(ownerUserId);
    const receipts = attention.receipts.filter((receipt) => receipt.eligible);
    const byTask = new Map<string, ProducerAttentionReceiptV1[]>();
    for (const receipt of receipts) {
      const taskId = taskIdFromEntrustedWorkSubjectRef(receipt.taskRef.subjectRef);
      if (!taskId) continue;
      const current = byTask.get(taskId) ?? [];
      current.push(receipt);
      byTask.set(taskId, current);
    }

    const ownerReads: EntrustedWorkOwnerReadV1[] = [];
    const artifactReader = this.deps.artifactReader?.createReadScope?.() ?? this.deps.artifactReader;
    for (const [taskId, taskReceipts] of byTask) {
      const task = await this.deps.tasks.get(taskId);
      if (!this.isCurrentVisibleTaskLink(task, ownerUserId, taskReceipts)) continue;
      const ownerRead = await this.compose(
        task,
        { taskId, viewer: { surface: 'human', userId: ownerUserId } },
        taskReceipts,
        artifactReader,
        attention.coverage,
      );
      if (ownerRead.preparedArtifact && ownerRead.attentionReceipts.some((receipt) => receipt.eligible)) {
        ownerReads.push(ownerRead);
      }
    }
    return { ownerReads, coverage: attention.coverage };
  }

  private isCurrentVisibleTaskLink(
    task: TaskItem | null,
    ownerUserId: string,
    receipts: readonly ProducerAttentionReceiptV1[],
  ): task is TaskItem {
    if (
      !task ||
      task.userId !== ownerUserId ||
      task.status === 'done' ||
      !task.entrustedWork ||
      task.entrustedWork.closure.state !== 'open'
    ) {
      return false;
    }
    const subjectRef = `task:work:${task.id}`;
    return receipts.every(
      (receipt) =>
        receipt.taskRef.subjectRef === subjectRef && receipt.taskRef.observedRevision === task.entrustedWork?.revision,
    );
  }

  private async compose(
    task: TaskItem,
    input: z.output<typeof ownerReadInputSchema>,
    producerReceipts: readonly ProducerAttentionReceiptV1[],
    artifactReader = this.deps.artifactReader,
    attentionCoverage: ProducerAttentionCoverageV1 = { state: 'complete' },
  ): Promise<EntrustedWorkOwnerReadV1> {
    this.assertViewer(task, input.viewer);
    const entrusted = task.entrustedWork;
    if (!entrusted) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_CONTRACT_MISSING', 'Task has no entrusted-work contract');
    }
    const completed = assertTerminalReadAllowed(task, entrusted, input);
    const observedRevision = input.observedRevision ?? entrusted.revision;
    if (observedRevision > entrusted.revision) {
      throw new EntrustedWorkOwnerReadError(
        'OWNER_READ_FUTURE_REVISION',
        'Observed entrusted-work revision is newer than canonical Task truth',
      );
    }
    const subjectRef = `task:work:${task.id}`;
    const ownerRef = `task:item:${task.id}`;
    const isCurrent = observedRevision === entrusted.revision;
    const terminal = projectTaskTerminal(task);
    const preparedArtifact = await this.resolvePreparedArtifact(
      task,
      entrusted,
      input,
      subjectRef,
      ownerRef,
      artifactReader,
    );
    const attentionReceipts = currentAttentionReceipts({
      isCurrent,
      entrusted,
      subjectRef,
      producerReceipts,
    });
    const timeRefs = projectEntrustedWorkTimeRefs(entrusted.time, subjectRef, ownerRef, entrusted.revision);
    const execution =
      entrusted.closure.state === 'open'
        ? await readOwnerTaskExecution({ task, isCurrent, reader: this.deps.taskExecution })
        : undefined;
    const candidate = {
      ...(completed
        ? {
            completion: {
              ...(entrusted.completion ? { recordedAt: entrusted.completion.recordedAt } : {}),
              evidenceRefs: entrusted.closure.evidenceRefs,
            },
          }
        : {}),
      ...(terminal ? { terminal } : {}),
      ...(execution ? { execution } : {}),
      work: {
        title: task.title,
        ownerCatId: task.ownerCatId,
        threadId: task.threadId,
        admittedAt: entrusted.admission.admittedAt,
        ownerNote: task.why,
        ...(entrusted.progress ? { progress: entrusted.progress } : {}),
      },
      envelope: {
        subjectRef,
        ownerRef,
        admissionReceiptRef: entrusted.admission.receiptRef,
        sourceRefs: entrusted.admission.sourceRefs,
        revision: entrusted.revision,
        freshness: {
          state: isCurrent ? ('current' as const) : ('stale' as const),
          observedRevision,
        },
        visibility: { ownerUserId: input.viewer.userId, human: true, cat: true },
      },
      brief: composeEntrustedWorkBrief({
        currentState: task.status,
        taskOwnerCatId: task.ownerCatId,
        ownerRef,
        ownerUserId: input.viewer.userId,
        revision: entrusted.revision,
        intendedOutcome: entrusted.intendedOutcome,
        admissionReceiptRef: entrusted.admission.receiptRef,
        freshnessState: isCurrent ? ('current' as const) : ('stale' as const),
        preparedArtifact,
        timeRefs,
        attentionCoverage,
        attentionReceipts,
        ...(terminal ? { terminal } : {}),
      }),
      ...(preparedArtifact ? { preparedArtifact } : {}),
      timeRefs,
      attentionCoverage,
      attentionReceipts,
    };
    const parsed = entrustedWorkOwnerReadV1Schema.safeParse(candidate);
    if (!parsed.success) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_CONTRACT_INVALID', parsed.error.message);
    }
    return parsed.data;
  }

  private async resolvePreparedArtifact(
    task: TaskItem,
    entrusted: EntrustedWorkContract,
    input: z.output<typeof ownerReadInputSchema>,
    subjectRef: string,
    ownerRef: string,
    artifactReader: PreparedArtifactReader | undefined,
  ): Promise<EntrustedWorkOwnerReadV1['preparedArtifact']> {
    const terminal = entrusted.closure.state !== 'open';
    const sealedArtifact = terminal ? entrusted.completion?.artifactSnapshot : undefined;
    if (terminal && !sealedArtifact) return undefined;
    const currentArtifact = await this.readPreparedArtifact(
      {
        artifactRefs: entrusted.artifactRefs,
        ownerRef,
        ownerUserId: input.viewer.userId,
        revision: entrusted.revision,
        subjectRef,
        threadId: task.threadId,
        viewer: input.viewer,
      },
      artifactReader,
    );
    if (!terminal) return currentArtifact;
    return sameCompletionArtifact(currentArtifact, sealedArtifact) ? currentArtifact : undefined;
  }

  private async readPreparedArtifact(
    input: {
      artifactRefs: readonly string[];
      subjectRef: string;
      ownerRef: string;
      revision: number;
      ownerUserId: string;
      threadId: string;
      viewer: EntrustedWorkOwnerReadInput['viewer'];
    },
    artifactReader: PreparedArtifactReader | undefined,
  ): Promise<EntrustedWorkOwnerReadV1['preparedArtifact']> {
    // Task accepts multiple evidence refs, but this projection requires one exact
    // prepared Artifact. An unknown primary must not make the canonical work unreadable.
    if (input.artifactRefs.length !== 1 || !artifactReader) return undefined;
    const artifactRef = input.artifactRefs[0];
    if (!artifactRef) return undefined;
    const artifact = await artifactReader.readPreparedArtifact({
      artifactRef,
      taskThreadId: input.threadId,
      taskSubjectRef: input.subjectRef,
      taskOwnerRef: input.ownerRef,
      taskRevision: input.revision,
      ownerUserId: input.ownerUserId,
      viewer: input.viewer,
    });
    if (artifact && artifact.artifactRef !== artifactRef) {
      throw new EntrustedWorkOwnerReadError(
        'OWNER_READ_CONTRACT_INVALID',
        'Artifact owner returned a different Artifact identity',
      );
    }
    return artifact ?? undefined;
  }

  private assertViewer(task: TaskItem, viewer: z.output<typeof ownerReadInputSchema>['viewer']): void {
    if (task.userId !== viewer.userId) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_FORBIDDEN', 'Entrusted-work Task belongs to another user');
    }
    if (viewer.surface === 'cat' && task.threadId !== viewer.threadId) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_FORBIDDEN', 'Entrusted-work Task belongs to another thread');
    }
  }
}
