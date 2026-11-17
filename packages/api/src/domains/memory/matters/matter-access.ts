import { type MatterActor, MatterMemoryError, type MatterSourceReaders, readMatterMessage } from './matter-source.js';

/** Server-owned permission dependency, separate from the writer's chosen return address. */
export interface MatterAccessGuard {
  threadId: string;
  messageId: string;
}

export async function captureMatterAccessGuard(
  readers: MatterSourceReaders,
  actor: MatterActor,
): Promise<MatterAccessGuard | undefined> {
  const id = actor.invocation?.triggerMessageId;
  if (!id) return undefined;
  const trigger = await readers.messageStore.getById(id);
  if (!trigger || trigger.visibility !== 'whisper') return undefined;
  const guard = { threadId: trigger.threadId, messageId: trigger.id };
  if (!(await readMatterMessage(readers, actor, guard))) throw new MatterMemoryError('not_available');
  return guard;
}

export async function canReadMatterGuards(
  readers: MatterSourceReaders,
  actor: MatterActor,
  guards: MatterAccessGuard[],
): Promise<boolean> {
  for (const guard of guards) if (!(await readMatterMessage(readers, actor, guard))) return false;
  return true;
}
