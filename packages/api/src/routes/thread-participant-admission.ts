import type { CatId } from '@cat-cafe/shared';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

type ParticipantThreadStore = Pick<IThreadStore, 'addParticipants' | 'get'>;
type ParticipantSocketManager = Pick<SocketManager, 'emitToUser'>;

export interface AdmitThreadParticipantsInput {
  userId: string;
  threadId: string;
  targetCats: readonly CatId[];
  threadStore: ParticipantThreadStore;
  socketManager: ParticipantSocketManager;
  emitPolicy: 'always' | 'membership-changed';
}

/**
 * Persist the final admitted targets as canonical thread participants and
 * publish the existing user-scoped Sidebar invalidation payload exactly once
 * for each real membership change.
 */
export async function admitThreadParticipants({
  userId,
  threadId,
  targetCats,
  threadStore,
  socketManager,
  emitPolicy,
}: AdmitThreadParticipantsInput): Promise<{ changed: boolean; participants: CatId[] }> {
  const uniqueTargets = [...new Set(targetCats)];
  if (uniqueTargets.length === 0) return { changed: false, participants: [] };

  const existing = await threadStore.get(threadId);
  if (!existing) throw new Error(`Cannot admit participants to missing thread: ${threadId}`);
  const before = [...existing.participants];
  await threadStore.addParticipants(threadId, uniqueTargets);
  const updated = await threadStore.get(threadId);
  if (!updated) throw new Error(`Thread disappeared during participant admission: ${threadId}`);
  const participants = updated.participants;
  const changed = uniqueTargets.some((catId) => !before.includes(catId));

  if (emitPolicy === 'always' || changed) {
    socketManager.emitToUser(userId, 'thread_updated', {
      threadId,
      participants,
    });
  }

  return { changed, participants };
}
