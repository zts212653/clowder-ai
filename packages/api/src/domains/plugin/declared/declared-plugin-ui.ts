import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginIconSpec } from '@cat-cafe/shared';
import type { UiCommandContribution, UiSlotItemContribution, WebhookContribution } from '@clowder-ai/plugin-contract';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

export interface PluginUiEntry {
  pluginId: string;
  instanceId: string;
  commandId: string;
  resourcePath: string;
  label: string;
  generation: string;
  order: number;
  icon?: PluginIconSpec;
}
interface Active {
  admission: PluginRuntimeAdmission;
  generation: string;
  lifetime: AbortController;
  commands: UiCommandContribution[];
  slots: UiSlotItemContribution[];
  resources: WebhookContribution[];
}
/** Uses existing public ui command/slot-item declarations; no package-specific router. */
export class DeclaredPluginUi {
  readonly #active = new Map<string, Active>();

  activate(admission: PluginRuntimeAdmission): void {
    const id = admission.instance.pluginInstanceId;
    this.deactivate(id);
    const contributions = admission.packageRecord.manifest.contributions ?? [];
    this.#active.set(id, {
      admission,
      generation: randomUUID(),
      lifetime: new AbortController(),
      commands: contributions.filter((c): c is UiCommandContribution => c.type === 'ui' && c.kind === 'command'),
      resources: contributions.filter((c): c is WebhookContribution => c.type === 'webhook'),
      slots: contributions.filter(
        (c): c is UiSlotItemContribution =>
          c.type === 'ui' && c.kind === 'slot-item' && c.group === 'activity-bar.bottom',
      ),
    });
  }
  deactivate(id: string): void {
    this.#active.get(id)?.lifetime.abort();
    this.#active.delete(id);
  }
  deactivateAll(): void {
    for (const id of this.#active.keys()) this.deactivate(id);
  }
  list(): PluginUiEntry[] {
    return [...this.#active]
      .flatMap(([instanceId, active]) =>
        active.slots.flatMap((slot) => {
          const command = active.commands.find((c) => c.id === slot.command);
          const resources = command
            ? active.resources.filter(
                (resource) =>
                  resource.methods.includes('GET') &&
                  !resource.path.includes(':') &&
                  resource.action.method === command.action.method &&
                  isDeepStrictEqual(resource.action.params ?? {}, command.action.params ?? {}),
              )
            : [];
          return command && resources.length === 1
            ? [
                {
                  pluginId: active.admission.packageRecord.pluginId,
                  instanceId,
                  commandId: command.id,
                  resourcePath: resources[0]!.path,
                  label: slot.label,
                  generation: active.generation,
                  order: slot.order ?? 0,
                  ...(active.admission.packageRecord.manifest.icon
                    ? {
                        icon:
                          typeof active.admission.packageRecord.manifest.icon === 'string'
                            ? active.admission.packageRecord.manifest.icon
                            : {
                                ...active.admission.packageRecord.manifest.icon,
                                src: `/api/plugin-manager/plugins/${encodeURIComponent(active.admission.packageRecord.pluginId)}/icon`,
                              },
                      }
                    : {}),
                },
              ]
            : [];
        }),
      )
      .sort((a, b) => a.order - b.order);
  }
  activation(
    pluginId: string,
    instanceId: string,
    generation: string,
  ): { signal: AbortSignal; assertCurrent(): void } | undefined {
    const active = this.#active.get(instanceId);
    if (!active || active.admission.packageRecord.pluginId !== pluginId || active.generation !== generation) return;
    return {
      signal: active.lifetime.signal,
      assertCurrent: () => {
        if (this.#active.get(instanceId) !== active) throw new Error('Plugin UI activation expired');
      },
    };
  }
}
