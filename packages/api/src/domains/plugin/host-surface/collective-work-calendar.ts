import { randomUUID } from 'node:crypto';
import { type CollectiveTaskPublicTime, collectiveWorkCalendarReadSchema, type TaskItem } from '@cat-cafe/shared';
import { withOwnerOperationRequest } from '../carrier/plugin-owner-operation-context.js';
import type { InstalledPluginOperations } from '../operations/plugin-operation-routes.js';

export interface CollectiveWorkCalendarReader {
  read(task: TaskItem): Promise<CollectiveTaskPublicTime | undefined>;
  createReadScope?(): CollectiveWorkCalendarReader;
}

/** The installed Collective owns the Task relation and public dates; Host only authenticates its owner read. */
export function createCollectiveWorkCalendarReader(
  operations: Pick<InstalledPluginOperations, 'runAction'>,
  ownerUserId: string,
): CollectiveWorkCalendarReader {
  async function load() {
    const controller = new AbortController();
    try {
      const result = await withOwnerOperationRequest(
        {
          pluginId: 'official.collective-connector',
          operationKey: 'calendar',
          actionId: 'read',
          userId: ownerUserId,
          requestId: randomUUID(),
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        },
        () => operations.runAction('official.collective-connector', 'calendar', 'read', {}),
      );
      if (!result.matched) return undefined;
      if (result.status !== 200) throw new Error('Collective calendar source unavailable');
      const read = collectiveWorkCalendarReadSchema.parse(result.body.data);
      const ids = new Set<string>();
      for (const item of read.items) {
        if (ids.has(item.taskId) || read.unavailableTaskIds.includes(item.taskId))
          throw new Error('Ambiguous task dates');
        ids.add(item.taskId);
      }
      return read;
    } finally {
      controller.abort();
    }
  }
  function reader(scoped: boolean): CollectiveWorkCalendarReader {
    let pending: ReturnType<typeof load> | undefined;
    return {
      createReadScope: () => reader(true),
      async read(task) {
        if (task.userId !== ownerUserId) return undefined;
        const linked =
          task.subjectKey?.startsWith('collective-work:') ||
          task.entrustedWork?.dataController?.binding.pluginId === 'official.collective-connector';
        try {
          const source = await (scoped ? (pending ??= load()) : load());
          const item = source?.items.find((item) => item.taskId === task.id);
          if (item)
            return item.taskRevision === task.entrustedWork?.revision
              ? { state: 'current', ...item }
              : { state: 'unavailable' };
          return linked || source?.unavailableTaskIds.includes(task.id) ? { state: 'unavailable' } : undefined;
        } catch {
          return linked ? { state: 'unavailable' } : undefined;
        }
      },
    };
  }
  return reader(false);
}
