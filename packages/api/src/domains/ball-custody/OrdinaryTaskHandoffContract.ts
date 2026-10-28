import type { TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';
import type { OrdinaryTaskExpectation, TaskMutationActor } from '../cats/services/stores/ports/OrdinaryTaskMutation.js';

/** Immutable request on the existing source Message, not a second responsibility record. */
export interface OrdinaryTaskHandoffRequest {
  readonly v: 1;
  readonly issuerCreatedAt?: number;
  readonly taskId: string;
  readonly expected: OrdinaryTaskExpectation;
  readonly issuer: TaskMutationActor;
  readonly targetCatId: string;
  readonly targetThreadId: string;
  readonly ownerCatId: string;
  readonly stopPrevious: boolean;
  readonly approvedAnchor?: { readonly catId: string; readonly threadId: string; readonly evidenceRef: string };
}

export interface OrdinaryTaskHandoffInput {
  readonly taskId: string;
  readonly expectedOwnerRevision: number;
  readonly actor: TaskMutationActor;
  readonly issuerCreatedAt?: number;
  readonly targetCatId: string;
  readonly targetThreadId: string;
  readonly stopPrevious?: boolean;
}

export type OrdinaryTaskHandoffResult =
  | { readonly kind: 'applied' | 'replayed'; readonly task: TaskItem }
  | { readonly kind: 'waiting'; readonly task: TaskItem; readonly executionRef: NonNullable<TaskItem['executionRef']> }
  | { readonly kind: 'refused'; readonly reason: string };

export class OrdinaryTaskHandoffError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const ref = z.string().min(1).max(300);
const execution = z
  .object({ invocationId: ref, parentInvocationId: ref, catId: ref, threadId: ref, sourceMessageId: ref.nullable() })
  .strict();
export const ordinaryTaskHandoffRequestSchema = z
  .object({
    v: z.literal(1),
    taskId: ref,
    issuerCreatedAt: z.number().nonnegative().optional(),
    expected: z
      .object({
        userId: ref,
        ownerCatId: ref.nullable(),
        threadId: ref,
        ownerRevision: z.number().int().nonnegative(),
        lastAppliedHandoffMessageRef: ref.nullable(),
        executionRef: execution.nullable(),
      })
      .strict(),
    issuer: z.object({ userId: ref, catId: ref, threadId: ref, invocationId: ref }).strict(),
    targetCatId: ref,
    targetThreadId: ref,
    ownerCatId: ref,
    stopPrevious: z.boolean(),
    approvedAnchor: z.object({ catId: ref, threadId: ref, evidenceRef: ref }).strict().optional(),
  })
  .strict();

/** A Task request must enter through Task admission, including malformed persisted requests. */
export function isTaskHandoffSource(
  source: { extra?: { taskHandoff?: unknown; taskHandoffInvalid?: unknown } } | null | undefined,
): boolean {
  return Boolean(source?.extra?.taskHandoff || source?.extra?.taskHandoffInvalid);
}
