import type { PluginIconSpec } from '@cat-cafe/shared';
import { z } from 'zod';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { HostPluginInvocationPort } from '../carrier/host-invocation.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export interface PluginConversationDependencies {
  inventory: Pick<PluginInventoryStore, 'snapshot'>;
  runtime: Pick<HostPluginInvocationPort, 'invoke'>;
  threads: Pick<IThreadStore, 'get'>;
}

export interface PluginConversationEntry {
  pluginId: string;
  instanceId: string;
  commandId: string;
  label: string;
  threadId: string | null;
  status: 'setup' | 'disabled' | 'listening' | 'paused' | 'error';
  badgeCount: number;
  order: number;
  icon?: PluginIconSpec;
  detail?: string;
}

const presentation = z.object({
  threadId: z.string().min(1).max(512).nullable(),
  label: z.string().min(1).max(80).optional(),
  status: z.enum(['setup', 'listening', 'paused', 'error']),
  badgeCount: z.number().int().min(0).max(9999).default(0),
  detail: z.string().max(500).optional(),
});

/** The installed manifest supplies identity; the live command supplies a read-only
 * native-conversation projection. Arbitrary plugin URLs never enter navigation. */
export async function listPluginConversations(
  deps: PluginConversationDependencies,
  ownerUserId: string,
): Promise<PluginConversationEntry[]> {
  const snapshot = await deps.inventory.snapshot();
  const candidates = snapshot.instances
    .filter((instance) => instance.lifecycleState === 'installed')
    .flatMap((instance) => {
      const pkg = snapshot.packages.find(
        (pkg) => pkg.packageDigest === instance.packageDigest && pkg.packageState === 'installed',
      );
      const manifest = pkg?.manifest;
      if (!manifest) return [];
      return (manifest.contributions ?? []).flatMap((slot) => {
        if (slot.type !== 'ui' || slot.kind !== 'slot-item' || slot.group !== 'thread-sidebar.top') return [];
        const commands = (manifest.contributions ?? []).filter(
          (command) => command.type === 'ui' && command.kind === 'command' && command.id === slot.command,
        );
        const command = commands.length === 1 ? commands[0] : undefined;
        if (command?.type !== 'ui' || command.kind !== 'command') return [];
        const entry: PluginConversationEntry = {
          pluginId: instance.pluginId,
          instanceId: instance.pluginInstanceId,
          commandId: command.id,
          label: slot.label,
          threadId: null,
          status: instance.activationState === 'error' ? 'error' : 'disabled',
          badgeCount: 0,
          order: slot.order ?? 0,
          ...(manifest.icon
            ? {
                icon:
                  typeof manifest.icon === 'string'
                    ? manifest.icon
                    : {
                        ...manifest.icon,
                        src: `/api/plugin-manager/plugins/${encodeURIComponent(instance.pluginId)}/icon`,
                      },
              }
            : {}),
        };
        return [{ instance, command, entry }];
      });
    });
  const results = await Promise.allSettled(
    candidates.map(async ({ instance, command, entry }) => {
      if (instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return entry;
      const view = presentation.parse(
        await deps.runtime.invoke(instance.pluginInstanceId, command.action.method, command.action.params ?? {}),
      );
      if (view.threadId) {
        const thread = await deps.threads.get(view.threadId);
        if (!thread || thread.deletedAt || thread.createdBy !== ownerUserId)
          throw new Error('Plugin conversation unavailable');
      }
      return { ...entry, ...view, label: view.label ?? entry.label };
    }),
  );
  return results
    .map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            ...candidates[index].entry,
            status: 'error' as const,
            detail: '助手暂时不可用，请打开插件设置查看。',
          },
    )
    .sort((a, b) => a.order - b.order);
}
