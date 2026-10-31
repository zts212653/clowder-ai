import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import type { GlobalArtifactWorkLineageResolverPort } from '../../../../video-studio/content-owner/global-artifact-work-lineage.js';
import {
  type LiveCompanionWorkReadOptions,
  readLiveCompanionWorkCandidates,
  resolveLiveCompanionWorkPublication,
} from '../../work/live-companion-work.js';
import type { HomeWorkActionPort } from './home-work-action.js';

/** Host fixes the project, stores and lineage owner; no human overview or model coordinates. */
export function createHomeWorkSource(deps: {
  ownerUserId: string;
  projectPath(): string;
  messages: Pick<IMessageStore, 'getById' | 'getByThread'>;
  threads: Pick<IThreadStore, 'listByProject'>;
  tasks: Pick<ITaskStore, 'get' | 'listByThread'>;
  lineage(): GlobalArtifactWorkLineageResolverPort | undefined;
  isCurrentCompanionThread?(userId: string, threadId: string): Promise<boolean>;
}): HomeWorkActionPort {
  const options = (assertCurrent: () => Promise<void>): LiveCompanionWorkReadOptions => {
    const projectPath = deps.projectPath();
    const artifactLineage = deps.lineage();
    return {
      ownerUserId: deps.ownerUserId,
      projectPath,
      messages: deps.messages,
      threads: deps.threads,
      tasks: deps.tasks,
      ...(deps.isCurrentCompanionThread ? { isCurrentCompanionThread: deps.isCurrentCompanionThread } : {}),
      ...(artifactLineage ? { artifactLineage } : {}),
      assertCurrent: async () => {
        await assertCurrent();
        if (deps.projectPath() !== projectPath) throw new Error('Home work project changed');
      },
    };
  };
  return {
    read: (scope, assertCurrent) => readLiveCompanionWorkCandidates(options(assertCurrent), scope),
    resolve: (scope, candidate, assertCurrent) =>
      resolveLiveCompanionWorkPublication(options(assertCurrent), scope, candidate),
  };
}
