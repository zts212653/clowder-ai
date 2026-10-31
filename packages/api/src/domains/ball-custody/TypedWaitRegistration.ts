import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type DeploymentAwaitStateV1, deploymentWaitPredicateSchema, type TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';
import { parseToolExecutionPolicy } from '../cats/services/agents/invocation/tool-execution-policy.js';
import { receiptOwnsOutcome } from '../runtime-deployment/DeploymentWaitAuthority.js';
import { isLivePluginWait } from './PluginWaitContinuation.js';

const nonEmpty = z.string().min(1);
const generation = z.number().int().positive().safe();
export const TYPED_WAIT_REGISTRATION_FIELD = 'typedWaitRegistration';

const authorizationSchema = z
  .object({
    ownerAuthProvenance: z.enum(['strict', 'compatibility_fallback', 'unknown']),
    toolExecutionPolicy: z
      .unknown()
      .transform((value, context) => {
        try {
          return parseToolExecutionPolicy(JSON.stringify(value));
        } catch {
          context.addIssue({ code: 'custom', message: 'invalid continuation tool policy' });
          return z.NEVER;
        }
      })
      .optional(),
  })
  .strict();

// Decode historical stored receipts without deleting data; only deployment/plugin waits confer live authority.
const receiptSchema = z
  .object({
    v: z.literal(1),
    invocationId: nonEmpty,
    /** Server-authenticated facts, sealed atomically with the Task wait; never callback payload. */
    authorization: authorizationSchema.optional(),
    source: z
      .object({
        kind: z.enum(['primary', 'adopted_hold']),
        sourceMessageId: nonEmpty,
        holdTaskId: nonEmpty.optional(),
        sessionHandoff: z
          .object({
            proposalId: nonEmpty,
            continuationEntryId: nonEmpty,
            sourceSessionId: nonEmpty,
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((source) => source.kind !== 'adopted_hold' || source.holdTaskId !== undefined),
    taskId: nonEmpty,
    taskKind: z.enum(['work', 'pr_tracking', 'issue_tracking']),
    userId: nonEmpty,
    catId: nonEmpty,
    threadId: nonEmpty,
    subjectRef: nonEmpty,
    generation,
    ownerFence: z.object({ kind: z.literal('containing_task'), generation }).strict(),
    // #1392: a wait may have no deadline (continuous tracking), and its receipt then has none either.
    expiresAt: z.number().int().positive().optional(),
    registeredAt: z.number().int().nonnegative(),
    predicateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    proofKind: z.enum(['typed_predicates', 'anchored_review', 'deployment_predicate']),
  })
  .strict()
  .superRefine((receipt, context) => {
    const deployment = receipt.proofKind === 'deployment_predicate';
    const subjectMatchesKind = deployment
      ? receipt.taskKind === 'work' && receipt.subjectRef.startsWith('deployment:')
      : receipt.taskKind !== 'work' &&
        (receipt.subjectRef.startsWith('pr:') || receipt.subjectRef.startsWith('issue:'));
    if (!subjectMatchesKind) {
      context.addIssue({
        code: 'custom',
        path: ['proofKind'],
        message: 'wait proof does not match Task/subject domain',
      });
    }
    if (deployment && receipt.expiresAt !== undefined) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'deployment waits are persistent' });
    }
    if (receipt.source.sessionHandoff && (!deployment || receipt.source.kind !== 'primary' || !receipt.authorization)) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'handoff waits require a deployment authorization snapshot',
      });
    }
  });

/** Private Task aggregate field, atomically installed with its await generation. */
export type TypedWaitRegistration = z.infer<typeof receiptSchema>;
export type TypedWaitAuthorization = z.infer<typeof authorizationSchema>;
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

type SupportedAwaitState = DeploymentAwaitStateV1;

export function typedWaitPredicateDigest(active: SupportedAwaitState): string {
  // A deployment predicate is relative to its registered runtime baseline.
  return createHash('sha256')
    .update(canonical({ when: active.continuation.when, baseline: active.baseline }))
    .digest('hex');
}

function deploymentProofKind(active: SupportedAwaitState): TypedWaitRegistration['proofKind'] | null {
  return active.autoRenew === false &&
    active.continuation.when.length === 1 &&
    deploymentWaitPredicateSchema.safeParse(active.continuation.when[0]).success
    ? 'deployment_predicate'
    : null;
}

export function parseTypedWaitRegistration(raw: unknown): TypedWaitRegistration | null {
  try {
    const parsed = receiptSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Deployment receipts are minted only for the Host-owned deployment continuation. */
export function createTypedWaitRegistration(input: {
  readonly task: TaskItem;
  readonly active: SupportedAwaitState;
  readonly invocationId: string;
  readonly source: TypedWaitSource;
  readonly authorization?: TypedWaitAuthorization;
}): TypedWaitRegistration | null {
  const { task, active, source, invocationId } = input;
  if (!active.subjectRef.startsWith('deployment:') || task.kind !== 'work') return null;
  const kind = deploymentProofKind(active);
  if (!kind) return null;
  return parseTypedWaitRegistration({
    v: 1,
    invocationId,
    ...(input.authorization ? { authorization: input.authorization } : {}),
    source,
    taskId: task.id,
    taskKind: task.kind,
    userId: task.userId,
    catId: task.ownerCatId,
    threadId: task.threadId,
    subjectRef: active.subjectRef,
    generation: active.generation,
    ownerFence: active.ownerFence,
    ...(active.expiresAt !== undefined ? { expiresAt: active.expiresAt } : {}),
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
  if (snapshot?.task.pluginWait) return isLivePluginWait(snapshot.task, identity, now, reference);
  if (!snapshot?.receipt) return false;
  const { task, receipt } = snapshot;
  if (receipt.proofKind !== 'deployment_predicate' || !receipt.subjectRef.startsWith('deployment:')) return false;
  const active = task.deploymentWait?.await;
  const terminal = task.deploymentWait?.waitOutcome;
  return (
    !!active &&
    task.status !== 'done' &&
    task.id === receipt.taskId &&
    task.kind === receipt.taskKind &&
    task.kind === 'work' &&
    task.userId === receipt.userId &&
    receipt.userId === identity.userId &&
    task.ownerCatId === receipt.catId &&
    receipt.catId === identity.catId &&
    task.threadId === receipt.threadId &&
    receipt.threadId === identity.threadId &&
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
    (receipt.expiresAt === undefined || receipt.expiresAt > now) &&
    receipt.registeredAt <= now &&
    (!terminal || terminal.generation !== receipt.generation) &&
    receipt.proofKind === deploymentProofKind(active) &&
    receipt.predicateDigest === typedWaitPredicateDigest(active) &&
    (!reference || (reference.taskId === task.id && reference.generation === receipt.generation))
  );
}

export function assertTypedWaitRegistrationInstallation(
  task: TaskItem,
  receipt: TypedWaitRegistration,
  previousReceipt?: TypedWaitRegistration | null,
): void {
  const outcome = task.deploymentWait?.waitOutcome;
  // A verified legacy publication may seal only the missing auth snapshot, never replace the
  // original receipt/source after its await was consumed. Stores read previousReceipt in the same CAS.
  if (
    outcome &&
    !task.deploymentWait?.await &&
    previousReceipt &&
    !previousReceipt.authorization &&
    receipt.authorization &&
    parseTypedWaitRegistration(receipt) &&
    outcome.registeredAt === previousReceipt.registeredAt &&
    receiptOwnsOutcome(task, outcome, previousReceipt, true) &&
    isDeepStrictEqual({ ...receipt, authorization: undefined }, { ...previousReceipt, authorization: undefined })
  )
    return;
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
