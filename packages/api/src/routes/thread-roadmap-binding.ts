import { stat } from 'node:fs/promises';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import {
  type RoadmapInput,
  type RoadmapMutation,
  ThreadRoadmapConflict,
} from '../domains/cats/services/stores/ports/ThreadRoadmap.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isEligibleReplyParent } from '../domains/cats/services/stores/visibility.js';
import {
  persistentRoadmapProject,
  recognizesRoadmapProject,
  roadmapFilePath,
} from '../domains/workspace/thread-roadmap-project.js';
import { canonicalizeWorkspaceContentLocator } from '../domains/workspace/workspace-content-source-utils.js';

export async function prepareRoadmapMutation(input: {
  roadmap: RoadmapInput;
  record: Pick<InvocationRecord, 'userId' | 'catId'>;
  thread: Thread;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
}): Promise<RoadmapMutation> {
  const { roadmap, thread, record } = input;
  const prefix = `thread:${thread.id}#`;
  if (!roadmap.sourceRef.startsWith(prefix))
    throw new Error('Roadmap source must identify a message in the current thread');
  const source = await input.messageStore.getById(roadmap.sourceRef.slice(prefix.length));
  if (
    !source ||
    source.userId !== record.userId ||
    !isEligibleReplyParent(source, {
      threadId: thread.id,
      viewer: thread.thinkingMode === 'play' ? { type: 'cat', catId: record.catId } : { type: 'user' },
    })
  )
    throw new Error('Roadmap source message is not readable in this invocation');
  const existing = thread.threadMetadata?.roadmap;
  if ((existing?.revision ?? null) !== roadmap.expectedRevision)
    throw new ThreadRoadmapConflict('Roadmap revision changed; reread metadata');
  const now = Date.now();
  if (roadmap.state === 'revoked') {
    if (!existing) throw new ThreadRoadmapConflict('There is no roadmap binding to revoke');
    if (existing.state === 'revoked')
      throw new ThreadRoadmapConflict('Roadmap is already revoked; original tombstone preserved');
    return {
      expectedRevision: roadmap.expectedRevision,
      value: {
        ...existing,
        state: 'revoked',
        revision: existing.revision + 1,
        revokedBy: record.catId,
        revokedAt: now,
        revokeSourceRef: roadmap.sourceRef,
      },
    };
  }
  const projectPath = await persistentRoadmapProject(roadmap.projectPath);
  if (!(await recognizesRoadmapProject(input.threadStore, record.userId, projectPath, thread, roadmap.projectPath)))
    throw new Error('Roadmap project is not an existing project visible to this user');
  await roadmapFilePath(projectPath, roadmap.path);
  const canonical = await canonicalizeWorkspaceContentLocator(projectPath, {
    worktreeId: 'roadmap',
    path: roadmap.path,
  });
  if (!(await stat(canonical.path)).isFile()) throw new Error('Roadmap target must be a file');
  if (projectPath.length > 1000 || canonical.locator.path.length > 1000)
    throw new Error('Normalized coordinates exceed the budget');
  return {
    expectedRevision: roadmap.expectedRevision,
    value: {
      v: 1,
      state: 'active',
      revision: (existing?.revision ?? 0) + 1,
      projectPath,
      path: canonical.locator.path,
      boundBy: record.catId,
      boundAt: now,
      sourceRef: roadmap.sourceRef,
    },
  };
}
