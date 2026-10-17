import type { CatId } from '@cat-cafe/shared';
import { ownedThreadFromSeed } from '../../cats/services/stores/ports/OwnedThreadSeed.js';
import type { IThreadStore, Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

/** A thin owner-bound ensure operation. The package chooses its key, parent, title and participants. */
export async function ensurePluginChildThread(input: {
  readonly store: IThreadStore;
  readonly ownerUserId: string;
  readonly pluginId: string;
  readonly key: string;
  readonly title: string;
  readonly parentThreadId: string;
  readonly participants: readonly CatId[];
  readonly boundThreadId?: string;
}): Promise<Thread> {
  const refuse = (): never => {
    throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Child thread ownership or ensure coordinates changed');
  };
  const parent = await input.store.get(input.parentThreadId);
  if (!parent || parent.id !== input.parentThreadId || parent.deletedAt || parent.createdBy !== input.ownerUserId)
    return refuse();
  const seed = {
    userId: input.ownerUserId,
    idempotencyKey: JSON.stringify(['plugin-thread', input.pluginId, input.key]),
    title: input.title,
    participants: input.participants,
    projectPath: parent.projectPath,
    parentThreadId: parent.id,
  };
  const expectedId = ownedThreadFromSeed(seed).id;
  if (input.boundThreadId !== undefined && input.boundThreadId !== expectedId) refuse();
  const created = await input.store.ensureOwnedThread(seed);
  if (created.id !== expectedId) refuse();
  const canonical = await input.store.get(expectedId);
  if (
    !canonical ||
    canonical.id !== expectedId ||
    canonical.deletedAt ||
    canonical.createdBy !== input.ownerUserId ||
    canonical.parentThreadId !== seed.parentThreadId ||
    canonical.projectPath !== seed.projectPath ||
    canonical.participants.length !== input.participants.length ||
    !input.participants.every((cat) => canonical.participants.includes(cat))
  )
    return refuse();
  return canonical;
}
