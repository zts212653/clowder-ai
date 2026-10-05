import {
  type EntrustedWorkOwnerReadV1,
  entrustedWorkOwnerReadV1Schema,
  type ProducerAttentionReceiptV1,
  type TaskItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { composeEntrustedWorkBrief } from './EntrustedWorkBriefComposer.js';
import type { NeedsMeProducerCatalog } from './NeedsMeProducerCatalog.js';
import type { PreparedArtifactReader } from './ports/PreparedArtifactReader.js';

export type { PreparedArtifactReader, PreparedArtifactReadInput } from './ports/PreparedArtifactReader.js';

const boundedRef = z.string().trim().min(1).max(1_000);

const ownerReadInputSchema = z
  .object({
    taskId: boundedRef,
    observedRevision: z.number().int().positive().optional(),
    includeCompleted: z.boolean().optional(),
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

export interface EntrustedWorkOwnerReadServiceDeps {
  readonly tasks: Pick<ITaskStore, 'get' | 'listByKind'>;
  readonly producerCatalog: NeedsMeProducerCatalog;
  readonly artifactReader?: PreparedArtifactReader;
}

export type EntrustedWorkOwnerReadInput = z.input<typeof ownerReadInputSchema>;

export class EntrustedWorkOwnerReadService {
  constructor(private readonly deps: EntrustedWorkOwnerReadServiceDeps) {}

  async read(rawInput: EntrustedWorkOwnerReadInput): Promise<EntrustedWorkOwnerReadV1> {
    const input = ownerReadInputSchema.parse(rawInput);
    const task = await this.deps.tasks.get(input.taskId);
    if (!task) throw new EntrustedWorkOwnerReadError('OWNER_READ_NOT_FOUND', 'Entrusted-work Task not found');
    this.assertViewer(task, input.viewer);
    const receipts =
      input.includeCompleted && task.entrustedWork?.closure.state === 'satisfied'
        ? []
        : await this.deps.producerCatalog.listCurrentReceipts(input.viewer.userId);
    return this.compose(task, input, receipts);
  }

  /** Product Schedule is a discardable global read over current Task owners, never a second work store. */
  async listForOwner(userId: string, view: 'active' | 'completed' = 'active'): Promise<EntrustedWorkOwnerReadV1[]> {
    const ownerUserId = boundedRef.parse(userId);
    const receipts = view === 'completed' ? [] : await this.deps.producerCatalog.listCurrentReceipts(ownerUserId);
    const tasks = await this.deps.tasks.listByKind('work');
    const currentTasks = tasks.filter(
      (task) =>
        task.userId === ownerUserId &&
        (view === 'completed'
          ? task.status === 'done' && task.entrustedWork?.closure.state === 'satisfied'
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
            viewer: { surface: 'human', userId: ownerUserId },
          },
          receipts,
          artifactReader,
        ),
      );
    }
    return ownerReads;
  }

  /** Global Needs Me is derived from producer-owned Task links and current Task/Artifact truth. */
  async listNeedsMeForOwner(userId: string): Promise<EntrustedWorkOwnerReadV1[]> {
    const ownerUserId = boundedRef.parse(userId);
    const receipts = (await this.deps.producerCatalog.listCurrentReceipts(ownerUserId)).filter(
      (receipt) => receipt.eligible,
    );
    const byTask = new Map<string, ProducerAttentionReceiptV1[]>();
    for (const receipt of receipts) {
      const taskId = taskIdFromSubjectRef(receipt.taskRef.subjectRef);
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
      );
      if (ownerRead.preparedArtifact && ownerRead.attentionReceipts.some((receipt) => receipt.eligible)) {
        ownerReads.push(ownerRead);
      }
    }
    return ownerReads;
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
  ): Promise<EntrustedWorkOwnerReadV1> {
    this.assertViewer(task, input.viewer);
    const entrusted = task.entrustedWork;
    if (!entrusted) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_CONTRACT_MISSING', 'Task has no entrusted-work contract');
    }
    const completed = task.status === 'done' && entrusted.closure.state === 'satisfied';
    if ((task.status === 'done' || entrusted.closure.state !== 'open') && !(input.includeCompleted && completed)) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_TERMINAL', 'Entrusted work is terminal');
    }
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
    const currentArtifact =
      completed && !entrusted.completion?.artifactSnapshot
        ? undefined
        : await this.readPreparedArtifact(
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
    const preparedArtifact = completed
      ? sameCompletionArtifact(currentArtifact, entrusted.completion?.artifactSnapshot)
        ? currentArtifact
        : undefined
      : currentArtifact;
    const attentionReceipts =
      isCurrent && !completed
        ? producerReceipts.filter(
            (receipt) =>
              receipt.taskRef.subjectRef === subjectRef && receipt.taskRef.observedRevision === entrusted.revision,
          )
        : [];
    const timeRefs = this.projectTaskTimeRefs(entrusted.time, subjectRef, ownerRef, entrusted.revision);
    const candidate = {
      ...(completed
        ? {
            completion: {
              ...(entrusted.completion ? { recordedAt: entrusted.completion.recordedAt } : {}),
              evidenceRefs: entrusted.closure.evidenceRefs,
            },
          }
        : {}),
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
        attentionReceipts,
      }),
      ...(preparedArtifact ? { preparedArtifact } : {}),
      timeRefs,
      attentionReceipts,
    };
    const parsed = entrustedWorkOwnerReadV1Schema.safeParse(candidate);
    if (!parsed.success) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_CONTRACT_INVALID', parsed.error.message);
    }
    return parsed.data;
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

  private projectTaskTimeRefs(
    time: NonNullable<TaskItem['entrustedWork']>['time'],
    subjectRef: string,
    ownerRef: string,
    revision: number,
  ) {
    const roles = [
      ['businessDeadline', 'business_deadline'],
      ['reviewBy', 'review_by'],
      ['plannedStart', 'planned_start'],
      ['actualStart', 'actual_start'],
      ['estimatedCompletion', 'estimated_completion'],
    ] as const;
    return roles.flatMap(([key, role]) => {
      const fact = time[key];
      return fact ? [{ role, subjectRef, ownerRef, revision, value: fact.value }] : [];
    });
  }
}

function taskIdFromSubjectRef(subjectRef: string): string | null {
  const prefix = 'task:work:';
  if (!subjectRef.startsWith(prefix)) return null;
  const taskId = subjectRef.slice(prefix.length).trim();
  return taskId.length > 0 ? taskId : null;
}

function sameCompletionArtifact(
  current: EntrustedWorkOwnerReadV1['preparedArtifact'],
  sealed: EntrustedWorkOwnerReadV1['preparedArtifact'],
): boolean {
  if (!current || !sealed) return false;
  return (['artifactRef', 'artifactRevision', 'completenessRef', 'previewRef', 'openInWorkspaceRef'] as const).every(
    (key) => current[key] === sealed[key],
  );
}
