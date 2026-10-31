import {
  type WorkspaceContentReviewAction,
  type WorkspaceContentReviewView,
  workspaceContentActorSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const receiptSchema = z
  .object({
    receipt: z
      .object({
        receiptRef: z.string(),
        reviewId: z.string(),
        operationId: z.string(),
        revision: z.number().int().positive(),
        actor: workspaceContentActorSchema,
        createdAt: z.string(),
        replayed: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export async function readWorkspaceOperationReceipt(base: string, reviewId: string, operationId: string) {
  try {
    const response = await apiFetch(
      `${base}/${encodeURIComponent(reviewId)}/operations/${encodeURIComponent(operationId)}`,
    );
    if (!response.ok) return undefined;
    const result = receiptSchema.parse(await response.json()).receipt;
    if (result && (result.reviewId !== reviewId || result.operationId !== operationId)) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

type PendingAction = {
  readonly operationId: string;
  readonly actionKey: string;
  readonly action: WorkspaceContentReviewAction;
  readonly expectedRevision: number;
};

function actionKey(action: WorkspaceContentReviewAction): string {
  if (action.kind !== 'reply') return JSON.stringify(action);
  return JSON.stringify({ kind: action.kind, annotationId: action.annotationId, body: action.body });
}

export function preparePendingAction(
  current: PendingAction | null,
  action: WorkspaceContentReviewAction,
  expectedRevision: number,
): PendingAction | null {
  const key = actionKey(action);
  if (current) return current.actionKey === key ? current : null;
  return { operationId: crypto.randomUUID(), actionKey: key, action, expectedRevision };
}

export async function reconcileActionFailure(
  load: (reviewId: string) => Promise<WorkspaceContentReviewView>,
  reviewId: string,
  pending: PendingAction,
  confirmedRejection: boolean,
  base: string,
): Promise<'confirmed' | 'discard' | 'retry'> {
  const refreshed = await load(reviewId).catch(() => undefined);
  const receipt = await readWorkspaceOperationReceipt(base, reviewId, pending.operationId);
  if (receipt && refreshed && receipt.actor.kind === 'human' && receipt.actor.actorId === refreshed.review.ownerUserId)
    return 'confirmed';
  if (receipt === null && (confirmedRejection || (refreshed && refreshed.review.revision !== pending.expectedRevision)))
    return 'discard';
  return 'retry';
}
