import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { Thread } from './ThreadStore.js';

/** Host-owned operation coordinates; never a caller-selected execution address. */
export interface OwnedThreadSeed {
  readonly userId: string;
  readonly idempotencyKey: string;
  /** Ordinary owner-created conversations may remain untitled until the first message. */
  readonly title: string | null;
  readonly titleSource?: 'user' | 'temporary';
  readonly participants: readonly CatId[];
  readonly projectPath?: string;
  readonly parentThreadId?: string;
}

export function ownedThreadFromSeed(seed: OwnedThreadSeed): Thread {
  if (!seed.userId.trim() || !seed.idempotencyKey.trim())
    throw new Error('Owned Thread requires an exact owner operation');
  const digest = createHash('sha256')
    .update(JSON.stringify([seed.userId, seed.idempotencyKey]))
    .digest('hex');
  const now = Date.now();
  return {
    id: `thread_owned_${digest.slice(0, 40)}`,
    createdBy: seed.userId,
    title: seed.title,
    titleSource: seed.titleSource ?? (seed.title ? 'user' : 'temporary'),
    projectPath: seed.projectPath ?? 'default',
    participants: [...new Set(seed.participants)],
    createdAt: now,
    lastActiveAt: now,
    ...(seed.parentThreadId ? { parentThreadId: seed.parentThreadId } : {}),
  };
}

export function requireOwnedThread(thread: Thread | null, userId: string): Thread {
  if (!thread || thread.createdBy !== userId || thread.deletedAt) {
    throw Object.assign(new Error('The owned execution Thread is unavailable'), {
      code: 'OWNER_ADMISSION_UNAVAILABLE',
    });
  }
  return thread;
}
