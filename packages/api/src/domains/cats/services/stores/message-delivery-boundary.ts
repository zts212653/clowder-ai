import type { CatId } from '@cat-cafe/shared';
import { type CanonicalVisibilityCursor, parseCursor } from './cursor.js';

/** Append-owned proof of one target's actual prompt boundary, not a second cursor slot. */
export interface MessageDeliveryBoundary {
  readonly v: 1;
  readonly cursor: CanonicalVisibilityCursor;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly turnInvocationId: string;
  readonly sourceMessageId: string;
}

export function parseMessageDeliveryBoundary(value: unknown): MessageDeliveryBoundary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const proof = value as Record<string, unknown>;
  if (proof.v !== 1) return undefined;
  for (const key of ['cursor', 'userId', 'threadId', 'catId', 'turnInvocationId', 'sourceMessageId']) {
    if (typeof proof[key] !== 'string' || proof[key].length === 0) return undefined;
  }
  try {
    if (parseCursor(proof.cursor as string)?.version !== 2) return undefined;
  } catch {
    return undefined;
  }
  return {
    v: 1,
    cursor: proof.cursor as CanonicalVisibilityCursor,
    userId: proof.userId as string,
    threadId: proof.threadId as string,
    catId: proof.catId as CatId,
    turnInvocationId: proof.turnInvocationId as string,
    sourceMessageId: proof.sourceMessageId as string,
  };
}

export function createMessageDeliveryBoundary(input: {
  cursor: string | undefined;
  userId: string;
  threadId: string;
  catId: CatId;
  turnInvocationId: string | undefined;
  sourceMessageId: string | undefined;
  succeeded: boolean;
}): MessageDeliveryBoundary | undefined {
  return input.succeeded ? parseMessageDeliveryBoundary({ ...input, v: 1 }) : undefined;
}
