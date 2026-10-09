import type { PluginManagerDetail } from '@cat-cafe/shared';
import type { IConnectorThreadBindingStore } from '../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import { SYSTEM_BINDING_KEY } from '../host-surface/plugin-thread-host.js';

export type PluginManagerBinding = NonNullable<PluginManagerDetail['bindings']>[number];

/** Projects existing Host-owned bindings without knowing any provider or external protocol. */
export class PluginManagerBindings {
  constructor(
    private readonly store: Pick<IConnectorThreadBindingStore, 'listByUser' | 'removeIfMatches'>,
    private readonly threads: {
      get(
        id: string,
      ):
        | Promise<{ createdBy: string; title?: string | null } | null>
        | { createdBy: string; title?: string | null }
        | null;
    },
  ) {}

  async list(pluginId: string, ownerUserId: string): Promise<PluginManagerBinding[]> {
    const rows = await this.store.listByUser(pluginId, ownerUserId);
    const result: PluginManagerBinding[] = [];
    for (const row of rows) {
      if (row.userId !== ownerUserId || row.connectorId !== pluginId || row.externalChatId === SYSTEM_BINDING_KEY)
        continue;
      const thread = await this.threads.get(row.threadId);
      result.push({
        key: row.externalChatId,
        threadId: row.threadId,
        threadTitle: thread?.createdBy === ownerUserId ? (thread.title ?? null) : null,
        createdAt: row.createdAt,
      });
    }
    return result;
  }

  disconnect(
    pluginId: string,
    ownerUserId: string,
    shown: Pick<PluginManagerBinding, 'key' | 'threadId' | 'createdAt'>,
  ): Promise<boolean> | boolean {
    if (shown.key === SYSTEM_BINDING_KEY) return false;
    return this.store.removeIfMatches({
      connectorId: pluginId,
      externalChatId: shown.key,
      threadId: shown.threadId,
      createdAt: shown.createdAt,
      userId: ownerUserId,
    });
  }
}
