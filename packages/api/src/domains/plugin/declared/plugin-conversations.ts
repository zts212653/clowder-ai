import type { PluginIconSpec } from '@cat-cafe/shared';
import { z } from 'zod';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { HostPluginInvocationPort } from '../carrier/host-invocation.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord } from '../host-inventory/types.js';

export interface PluginConversationDependencies {
  inventory: Pick<PluginInventoryStore, 'snapshot'> & Partial<Pick<PluginInventoryStore, 'transaction'>>;
  runtime: Pick<HostPluginInvocationPort, 'invoke'>;
  threads: Pick<IThreadStore, 'get'>;
}

export interface PluginConversationEntry {
  pluginId: string;
  instanceId: string;
  commandId: string;
  label: string;
  threadId: string | null;
  status: 'setup' | 'disabled' | 'starting' | 'ready' | 'error';
  openable: boolean;
  order: number;
  icon?: PluginIconSpec;
  detail?: string;
}

function conversationStatus(instance: PluginInstanceRecord): PluginConversationEntry['status'] {
  if (instance.activationState === 'error') return 'error';
  if (instance.activationState === 'enabling') return 'starting';
  if (instance.activationState !== 'enabled') return 'disabled';
  if (['crashed', 'degraded', 'stopped'].includes(instance.runtimeState)) return 'error';
  if (['starting', 'handshaking'].includes(instance.runtimeState)) return 'starting';
  return instance.configReadiness === 'ready' ? 'ready' : 'setup';
}

/** Reads installed metadata, Host health and confirmed native bindings only.
 * No plugin action runs during discovery, including on hung instances. */
export async function listPluginConversations(
  deps: PluginConversationDependencies,
  ownerUserId: string,
): Promise<PluginConversationEntry[]> {
  const snapshot = await deps.inventory.snapshot();
  const candidates = snapshot.instances
    .filter((instance) => instance.lifecycleState === 'installed')
    .flatMap((instance) => {
      const manifest = snapshot.packages.find(
        (pkg) => pkg.packageDigest === instance.packageDigest && pkg.packageState === 'installed',
      )?.manifest;
      if (!manifest) return [];
      const icon =
        !manifest.icon || typeof manifest.icon === 'string'
          ? manifest.icon
          : {
              ...manifest.icon,
              src: `/api/plugin-manager/plugins/${encodeURIComponent(instance.pluginId)}/icon`,
            };
      return (manifest.contributions ?? []).flatMap((slot) => {
        if (slot.type !== 'ui' || slot.kind !== 'slot-item' || slot.group !== 'thread-sidebar.top') return [];
        const command = (manifest.contributions ?? []).find(
          (item) => item.type === 'ui' && item.kind === 'command' && item.id === slot.command,
        );
        if (command?.type !== 'ui' || command.kind !== 'command') return [];
        const openable = instance.activationState === 'enabled' && instance.runtimeState === 'healthy';
        const binding = instance.conversationBindings?.find(
          (item) => item.commandId === command.id && item.ownerUserId === ownerUserId,
        );
        const entry: PluginConversationEntry = {
          pluginId: instance.pluginId,
          instanceId: instance.pluginInstanceId,
          commandId: command.id,
          label: slot.label,
          threadId: null,
          status: conversationStatus(instance),
          openable,
          order: slot.order ?? 0,
          ...(icon ? { icon } : {}),
        };
        return [{ entry, binding }];
      });
    });
  const results = await Promise.allSettled(
    candidates.map(async ({ entry, binding }) => {
      if (!binding) return entry;
      const thread = await deps.threads.get(binding.threadId);
      if (!thread || thread.deletedAt || thread.createdBy !== ownerUserId) return entry;
      return { ...entry, threadId: thread.id, label: thread.title || entry.label };
    }),
  );
  return results
    .map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            ...candidates[index].entry,
            threadId: candidates[index].binding?.threadId ?? null,
            status: 'error' as const,
            detail: '主会话暂时无法读取，请稍后重试。',
          },
    )
    .sort((a, b) => a.order - b.order);
}

/** Generic commands keep click semantics. An explicit owner action resolves a
 * target; the Host validates and durably binds it to this installed instance. */
export async function openPluginConversation(
  deps: PluginConversationDependencies,
  ownerUserId: string,
  instanceId: string,
  commandId: string,
) {
  const entry = (await listPluginConversations(deps, ownerUserId)).find(
    (item) => item.instanceId === instanceId && item.commandId === commandId,
  );
  if (!entry) throw new Error('Resident entry unavailable');
  if (entry.threadId || !entry.openable) return entry;
  if (!deps.inventory.transaction) throw new Error('Conversation binding storage unavailable');
  const snapshot = await deps.inventory.snapshot();
  const instance = snapshot.instances.find((item) => item.pluginInstanceId === instanceId);
  if (!instance) throw new Error('Resident instance unavailable');
  const manifest = snapshot.packages.find((pkg) => pkg.packageDigest === instance.packageDigest)?.manifest;
  const command = manifest?.contributions?.find(
    (item) => item.type === 'ui' && item.kind === 'command' && item.id === commandId,
  );
  if (command?.type !== 'ui' || command.kind !== 'command') throw new Error('Resident command unavailable');
  const view = z
    .object({ threadId: z.string().min(1).max(512).nullable() })
    .parse(await deps.runtime.invoke(instanceId, command.action.method, command.action.params ?? {}));
  if (!view.threadId) return { ...entry, status: 'setup' as const };
  const thread = await deps.threads.get(view.threadId);
  if (!thread || thread.deletedAt || thread.createdBy !== ownerUserId)
    throw new Error('Plugin conversation unavailable');
  await deps.inventory.transaction(async (transaction) => {
    const current = await transaction.instances.get(instanceId);
    if (
      !current ||
      current.lifecycleState !== 'installed' ||
      current.packageDigest !== instance.packageDigest ||
      current.lifecycleRevision !== instance.lifecycleRevision
    )
      throw new Error('Plugin changed while opening its conversation');
    const bindings = current.conversationBindings ?? [];
    if (
      bindings.some(
        (item) => item.commandId === commandId && item.ownerUserId === ownerUserId && item.threadId === thread.id,
      )
    )
      return;
    await transaction.instances.put({
      ...current,
      conversationBindings: [
        ...bindings.filter((item) => item.commandId !== commandId || item.ownerUserId !== ownerUserId),
        { role: 'main-conversation', ownerUserId, commandId, threadId: thread.id },
      ],
    });
  });
  return { ...entry, threadId: thread.id, label: thread.title || entry.label };
}
