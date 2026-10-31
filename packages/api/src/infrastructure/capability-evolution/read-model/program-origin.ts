import {
  type EvolutionProgramOriginV1,
  type EvolutionProgramV1,
  evolutionProgramOriginV1Schema,
} from '@cat-cafe/shared';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { IEvolutionProgramEventLog } from '../program-event-log.js';

export type EvolutionProgramOriginResolver = (
  program: Pick<EvolutionProgramV1, 'programId' | 'workspaceId'>,
) => Promise<EvolutionProgramOriginV1 | undefined>;

/** Read only after the route's workspace fence. Origin is server-authored creation provenance,
 * not a caller-provided association, a guessed asset name, or a persisted copy of thread content. */
export function createEvolutionProgramOriginResolver(dependencies: {
  eventLog: Pick<IEvolutionProgramEventLog, 'read'>;
  threadStore: Pick<IThreadStore, 'get'>;
}): EvolutionProgramOriginResolver {
  return async (program) => {
    const [created] = await dependencies.eventLog.read(program.programId);
    if (
      created?.event.type !== 'program_created' ||
      created.programId !== program.programId ||
      created.event.workspaceId !== program.workspaceId
    )
      return undefined;
    const threadId = /^thread:([a-zA-Z0-9_-]+):invocation:[^:\s]+:message:/.exec(created.originRef)?.[1];
    if (!threadId) return undefined;
    const thread = await dependencies.threadStore.get(threadId);
    if (!thread || thread.deletedAt || `user:${thread.createdBy}` !== program.workspaceId) return undefined;
    const createdByCatId = /^cat:([a-zA-Z0-9_-]+)$/.exec(created.actorRef)?.[1];
    const result = evolutionProgramOriginV1Schema.safeParse({
      threadId,
      title: thread.title?.trim() || '未命名对话',
      ...(createdByCatId ? { createdByCatId } : {}),
    });
    return result.success ? result.data : undefined;
  };
}
