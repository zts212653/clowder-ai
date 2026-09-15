import { createHash } from 'node:crypto';
import type { AwaitStateV1, TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';

const nonEmpty = z.string().min(1);
const generation = z.number().int().positive().safe();
export const TYPED_WAIT_REGISTRATION_FIELD = 'typedWaitRegistration';

const receiptSchema = z
  .object({
    v: z.literal(1),
    invocationId: nonEmpty,
    source: z
      .object({
        kind: z.enum(['primary', 'adopted_hold']),
        sourceMessageId: nonEmpty,
        holdTaskId: nonEmpty.optional(),
      })
      .strict()
      .refine((source) => source.kind !== 'adopted_hold' || source.holdTaskId !== undefined),
    taskId: nonEmpty,
    taskKind: z.enum(['pr_tracking', 'issue_tracking']),
    userId: nonEmpty,
    catId: nonEmpty,
    threadId: nonEmpty,
    subjectRef: nonEmpty,
    generation,
    ownerFence: z.object({ kind: z.literal('containing_task'), generation }).strict(),
    expiresAt: z.number().int().positive(),
    registeredAt: z.number().int().nonnegative(),
    predicateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    proofKind: z.enum(['typed_predicates', 'anchored_review']),
  })
  .strict();

/** Private Task aggregate field, atomically installed with its await generation. */
export type TypedWaitRegistration = z.infer<typeof receiptSchema>;
export type TypedWaitSource = TypedWaitRegistration['source'];
export interface TypedWaitRegistrationSnapshot {
  readonly task: TaskItem;
  readonly receipt: TypedWaitRegistration | null;
}
export interface TypedWaitContinuationIdentity {
  readonly invocationId: string;
  readonly userId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly holdTaskId?: string;
}
export interface TypedWaitReference {
  readonly taskId: string;
  readonly generation: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonical(entry))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function typedWaitPredicateDigest(active: AwaitStateV1): string {
  // A predicate is relative to its registered baseline (including the covered review HEAD).
  return createHash('sha256')
    .update(canonical({ when: active.continuation.when, baseline: active.baseline }))
    .digest('hex');
}

function proofKind(active: AwaitStateV1): TypedWaitRegistration['proofKind'] | null {
  let review = false;
  if (active.continuation.when.length === 0) return null;
  const kinds = active.subjectRef.startsWith('pr:')
    ? [
        'pr_head_changed',
        'pr_review_result_available',
        'pr_review_decision_changed',
        'pr_review_thread_changed',
        'pr_ci_terminal',
        'pr_became_conflicting',
      ]
    : active.subjectRef.startsWith('issue:')
      ? ['issue_comment_added', 'issue_author_commented']
      : [];
  for (const predicate of active.continuation.when) {
    if (!kinds.includes(predicate.kind)) return null;
    if (predicate.kind === 'pr_review_result_available') {
      if (!Number.isSafeInteger(predicate.triggerCommentId) || (predicate.triggerCommentId ?? 0) <= 0) return null;
      review = true;
    }
  }
  return review ? 'anchored_review' : 'typed_predicates';
}

export function parseTypedWaitRegistration(raw: unknown): TypedWaitRegistration | null {
  try {
    const parsed = receiptSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Called only after the registration producer has verified every anchored review trigger. */
export function createTypedWaitRegistration(input: {
  readonly task: TaskItem;
  readonly active: AwaitStateV1;
  readonly invocationId: string;
  readonly source: TypedWaitSource;
}): TypedWaitRegistration | null {
  const { task, active, source, invocationId } = input;
  const kind = proofKind(active);
  if (!kind) return null;
  return parseTypedWaitRegistration({
    v: 1,
    invocationId,
    source,
    taskId: task.id,
    taskKind: task.kind,
    userId: task.userId,
    catId: task.ownerCatId,
    threadId: task.threadId,
    subjectRef: active.subjectRef,
    generation: active.generation,
    ownerFence: active.ownerFence,
    expiresAt: active.expiresAt,
    registeredAt: active.createdAt,
    predicateDigest: typedWaitPredicateDigest(active),
    proofKind: kind,
  });
}

export function isLiveTypedWaitRegistration(
  snapshot: TypedWaitRegistrationSnapshot | null,
  identity: TypedWaitContinuationIdentity,
  now: number,
  reference?: TypedWaitReference,
): boolean {
  if (!snapshot?.receipt) return false;
  const { task, receipt } = snapshot;
  const active = task.automationState?.await;
  const terminal = task.automationState?.waitOutcome;
  return (
    !!active &&
    task.status !== 'done' &&
    task.id === receipt.taskId &&
    task.kind === receipt.taskKind &&
    task.kind === (receipt.subjectRef.startsWith('pr:') ? 'pr_tracking' : 'issue_tracking') &&
    task.userId === receipt.userId &&
    receipt.userId === identity.userId &&
    task.ownerCatId === receipt.catId &&
    receipt.catId === identity.catId &&
    task.threadId === receipt.threadId &&
    receipt.threadId === identity.threadId &&
    task.subjectKey === receipt.subjectRef &&
    active.subjectRef === receipt.subjectRef &&
    receipt.invocationId === identity.invocationId &&
    receipt.source.sourceMessageId === identity.sourceMessageId &&
    receipt.source.holdTaskId === identity.holdTaskId &&
    active.generation === receipt.generation &&
    active.ownerFence.kind === 'containing_task' &&
    active.ownerFence.generation === receipt.generation &&
    receipt.ownerFence.generation === receipt.generation &&
    active.createdAt === receipt.registeredAt &&
    active.expiresAt === receipt.expiresAt &&
    receipt.expiresAt > now &&
    receipt.registeredAt <= now &&
    (!terminal || terminal.generation !== receipt.generation) &&
    receipt.proofKind === proofKind(active) &&
    receipt.predicateDigest === typedWaitPredicateDigest(active) &&
    (!reference || (reference.taskId === task.id && reference.generation === receipt.generation))
  );
}

export function assertTypedWaitRegistrationInstallation(task: TaskItem, receipt: TypedWaitRegistration): void {
  if (
    !isLiveTypedWaitRegistration(
      { task, receipt },
      {
        invocationId: receipt.invocationId,
        userId: receipt.userId,
        catId: receipt.catId,
        threadId: receipt.threadId,
        sourceMessageId: receipt.source.sourceMessageId,
        ...(receipt.source.holdTaskId ? { holdTaskId: receipt.source.holdTaskId } : {}),
      },
      Date.now(),
    )
  )
    throw new Error('typed wait registration does not bind the installed Task generation');
}
