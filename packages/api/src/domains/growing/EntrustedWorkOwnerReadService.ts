import {
  type EntrustedWorkOwnerReadV1,
  entrustedWorkOwnerReadV1Schema,
  type ProducerAttentionReceiptV1,
  type TaskItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { NeedsMeProducerCatalog } from './NeedsMeProducerCatalog.js';

const boundedRef = z.string().trim().min(1).max(1_000);

const ownerReadInputSchema = z
  .object({
    taskId: boundedRef,
    observedRevision: z.number().int().positive().optional(),
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

export interface PreparedArtifactReadInput {
  readonly artifactRef: string;
  readonly taskThreadId: string;
  readonly taskSubjectRef: string;
  readonly taskOwnerRef: string;
  readonly taskRevision: number;
  readonly ownerUserId: string;
}

export interface PreparedArtifactReader {
  readPreparedArtifact(
    input: PreparedArtifactReadInput,
  ): Promise<NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']> | null>;
}

export type EntrustedWorkOwnerReadErrorCode =
  | 'OWNER_READ_NOT_FOUND'
  | 'OWNER_READ_FORBIDDEN'
  | 'OWNER_READ_CONTRACT_MISSING'
  | 'OWNER_READ_TERMINAL'
  | 'OWNER_READ_FUTURE_REVISION'
  | 'OWNER_READ_ARTIFACT_AMBIGUOUS'
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
    const receipts = await this.deps.producerCatalog.listCurrentReceipts(input.viewer.userId);
    return this.compose(task, input, receipts);
  }

  /** Product Schedule is a discardable global read over current Task owners, never a second work store. */
  async listForOwner(userId: string): Promise<EntrustedWorkOwnerReadV1[]> {
    const ownerUserId = boundedRef.parse(userId);
    const receipts = await this.deps.producerCatalog.listCurrentReceipts(ownerUserId);
    const tasks = await this.deps.tasks.listByKind('work');
    const currentTimedTasks = tasks.filter(
      (task) =>
        task.userId === ownerUserId &&
        task.status !== 'done' &&
        task.entrustedWork?.closure.state === 'open' &&
        (task.entrustedWork.time.businessDeadline !== undefined || task.entrustedWork.time.reviewBy !== undefined),
    );
    return Promise.all(
      currentTimedTasks.map((task) =>
        this.compose(
          task,
          {
            taskId: task.id,
            viewer: { surface: 'human', userId: ownerUserId },
          },
          receipts,
        ),
      ),
    );
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
    for (const [taskId, taskReceipts] of byTask) {
      const task = await this.deps.tasks.get(taskId);
      if (!this.isCurrentVisibleTaskLink(task, ownerUserId, taskReceipts)) continue;
      const ownerRead = await this.compose(
        task,
        { taskId, viewer: { surface: 'human', userId: ownerUserId } },
        taskReceipts,
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
  ): Promise<EntrustedWorkOwnerReadV1> {
    if (task.userId !== input.viewer.userId) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_FORBIDDEN', 'Entrusted-work Task belongs to another user');
    }
    if (input.viewer.surface === 'cat' && task.threadId !== input.viewer.threadId) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_FORBIDDEN', 'Entrusted-work Task belongs to another thread');
    }
    const entrusted = task.entrustedWork;
    if (!entrusted) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_CONTRACT_MISSING', 'Task has no entrusted-work contract');
    }
    if (task.status === 'done' || entrusted.closure.state !== 'open') {
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
    const preparedArtifact = await this.readPreparedArtifact({
      artifactRefs: entrusted.artifactRefs,
      ownerRef,
      ownerUserId: input.viewer.userId,
      revision: entrusted.revision,
      subjectRef,
      threadId: task.threadId,
    });
    const attentionReceipts = isCurrent
      ? producerReceipts.filter(
          (receipt) =>
            receipt.taskRef.subjectRef === subjectRef && receipt.taskRef.observedRevision === entrusted.revision,
        )
      : [];
    const candidate = {
      envelope: {
        subjectRef,
        ownerRef,
        sourceRefs: entrusted.admission.sourceRefs,
        revision: entrusted.revision,
        freshness: {
          state: isCurrent ? ('current' as const) : ('stale' as const),
          observedRevision,
        },
        visibility: { ownerUserId: input.viewer.userId, human: true, cat: true },
      },
      ...(preparedArtifact ? { preparedArtifact } : {}),
      timeRefs: this.projectTaskTimeRefs(entrusted.time, subjectRef, ownerRef, entrusted.revision),
      attentionReceipts,
    };
    const parsed = entrustedWorkOwnerReadV1Schema.safeParse(candidate);
    if (!parsed.success) {
      throw new EntrustedWorkOwnerReadError('OWNER_READ_CONTRACT_INVALID', parsed.error.message);
    }
    return parsed.data;
  }

  private async readPreparedArtifact(input: {
    artifactRefs: readonly string[];
    subjectRef: string;
    ownerRef: string;
    revision: number;
    ownerUserId: string;
    threadId: string;
  }): Promise<EntrustedWorkOwnerReadV1['preparedArtifact']> {
    if (input.artifactRefs.length === 0 || !this.deps.artifactReader) return undefined;
    if (input.artifactRefs.length > 1) {
      throw new EntrustedWorkOwnerReadError(
        'OWNER_READ_ARTIFACT_AMBIGUOUS',
        'Entrusted work has multiple Artifact refs but no canonical primary Artifact coordinate',
      );
    }
    const artifactRef = input.artifactRefs[0];
    if (!artifactRef) return undefined;
    const artifact = await this.deps.artifactReader.readPreparedArtifact({
      artifactRef,
      taskThreadId: input.threadId,
      taskSubjectRef: input.subjectRef,
      taskOwnerRef: input.ownerRef,
      taskRevision: input.revision,
      ownerUserId: input.ownerUserId,
    });
    if (artifact && artifact.artifactRef !== artifactRef) {
      throw new EntrustedWorkOwnerReadError(
        'OWNER_READ_CONTRACT_INVALID',
        'Artifact owner returned a different Artifact identity',
      );
    }
    return artifact ?? undefined;
  }

  private projectTaskTimeRefs(
    time: { businessDeadline?: { value: number }; reviewBy?: { value: number } },
    subjectRef: string,
    ownerRef: string,
    revision: number,
  ) {
    return [
      ...(time.businessDeadline
        ? [{ role: 'business_deadline' as const, subjectRef, ownerRef, revision, value: time.businessDeadline.value }]
        : []),
      ...(time.reviewBy
        ? [{ role: 'review_by' as const, subjectRef, ownerRef, revision, value: time.reviewBy.value }]
        : []),
    ];
  }
}

function taskIdFromSubjectRef(subjectRef: string): string | null {
  const prefix = 'task:work:';
  if (!subjectRef.startsWith(prefix)) return null;
  const taskId = subjectRef.slice(prefix.length).trim();
  return taskId.length > 0 ? taskId : null;
}
