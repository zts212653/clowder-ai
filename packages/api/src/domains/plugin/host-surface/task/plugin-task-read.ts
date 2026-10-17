import type { PluginWaitState, TaskItem } from '@cat-cafe/shared';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import { snapshotPluginProtocolData } from '../../carrier/plugin-protocol-data.js';

type Work = NonNullable<TaskItem['entrustedWork']>;

/** Read-only package data. This summary conveys no admission or execution authority. */
export type PluginTaskReadItem = Pick<
  TaskItem,
  | 'id'
  | 'kind'
  | 'threadId'
  | 'subjectKey'
  | 'title'
  | 'ownerCatId'
  | 'status'
  | 'why'
  | 'createdBy'
  | 'createdAt'
  | 'updatedAt'
> & {
  readonly userId: string | null;
  readonly pluginWait?: Pick<PluginWaitState, 'pluginInstanceId' | 'generation' | 'await' | 'waitOutcome'>;
  readonly entrustedWork?: {
    readonly revision: Work['revision'];
    readonly time?: Work['time'];
    readonly artifactRefs: readonly string[];
    readonly closure: Pick<Work['closure'], 'state'>;
    readonly admission: { readonly sourceRefs: readonly string[] };
  };
};

function projectWait(wait: PluginWaitState): NonNullable<PluginTaskReadItem['pluginWait']> {
  return {
    pluginInstanceId: wait.pluginInstanceId,
    generation: wait.generation,
    ...(wait.await === undefined
      ? {}
      : {
          await: {
            generation: wait.await.generation,
            ...(wait.await.expiresAt === undefined ? {} : { expiresAt: wait.await.expiresAt }),
          },
        }),
    ...(wait.waitOutcome === undefined
      ? {}
      : {
          waitOutcome: {
            outcomeId: wait.waitOutcome.outcomeId,
            generation: wait.waitOutcome.generation,
            ownerFence: { kind: wait.waitOutcome.ownerFence.kind, generation: wait.waitOutcome.ownerFence.generation },
            reason: wait.waitOutcome.reason,
            delivery: wait.waitOutcome.delivery,
          },
        }),
  };
}

export function projectPluginTaskRead(task: TaskItem): PluginTaskReadItem {
  const work = task.entrustedWork;
  return snapshotPluginProtocolData({
    id: task.id,
    kind: task.kind,
    threadId: task.threadId,
    subjectKey: task.subjectKey,
    title: task.title,
    ownerCatId: task.ownerCatId,
    status: task.status,
    why: task.why,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    userId: task.userId ?? null,
    ...(task.pluginWait === undefined ? {} : { pluginWait: projectWait(task.pluginWait) }),
    ...(work === undefined
      ? {}
      : {
          entrustedWork: {
            revision: work.revision,
            artifactRefs: work.artifactRefs,
            ...(work.time === undefined ? {} : { time: work.time }),
            closure: { state: work.closure.state },
            admission: { sourceRefs: work.admission.sourceRefs },
          },
        }),
  }) as PluginTaskReadItem;
}

export async function projectOwnedPluginTasks(
  tasks: readonly TaskItem[],
  ownerUserId: string,
  threads: Pick<IThreadStore, 'get'> | undefined,
): Promise<readonly PluginTaskReadItem[]> {
  const visible: PluginTaskReadItem[] = [];
  for (const task of tasks) {
    if (task.userId != null) {
      if (task.userId !== ownerUserId) continue;
    } else {
      // Legacy ownership is established by the actual thread, never the caller.
      const thread = await threads?.get(task.threadId);
      if (!thread || thread.id !== task.threadId || thread.createdBy !== ownerUserId || thread.deletedAt) continue;
    }
    visible.push(projectPluginTaskRead(task));
  }
  return Object.freeze(visible);
}
