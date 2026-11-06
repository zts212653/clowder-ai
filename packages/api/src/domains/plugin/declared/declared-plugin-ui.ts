import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginIconSpec } from '@cat-cafe/shared';
import type { UiCommandContribution, UiSlotItemContribution, WebhookContribution } from '@clowder-ai/plugin-contract';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

export const composerQuickPhrasesGroup = 'composer.quick-phrases';
type PluginUiGroup = 'activity-bar.bottom' | typeof composerQuickPhrasesGroup;

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
      slots: contributions.filter((c): c is UiSlotItemContribution => c.type === 'ui' && c.kind === 'slot-item'),
    });
  }
  deactivate(id: string): void {
    this.#active.get(id)?.lifetime.abort();
    this.#active.delete(id);
  }
  deactivateAll(): void {
    for (const id of this.#active.keys()) this.deactivate(id);
  }
  list(group: PluginUiGroup = 'activity-bar.bottom'): PluginUiEntry[] {
    return (
      [...this.#active]
        // The composer can submit a user-confirmed draft to this package only.
        .filter(
          ([, { admission }]) =>
            group === 'activity-bar.bottom' || admission.packageRecord.pluginId === 'official.quick-phrases',
        )
        .flatMap(([instanceId, active]) => {
          const { pluginId, manifest } = active.admission.packageRecord;
          const icon =
            typeof manifest.icon === 'object'
              ? { ...manifest.icon, src: `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/icon` }
              : manifest.icon;
          return active.slots
            .filter((slot) => slot.group === group)
            .flatMap((slot) => {
              const command = active.commands.find((c) => c.id === slot.command);
              if (!command) return [];
              const resources = active.resources.filter(
                (resource) =>
                  resource.methods.includes('GET') &&
                  !resource.path.includes(':') &&
                  resource.action.method === command.action.method &&
                  isDeepStrictEqual(resource.action.params ?? {}, command.action.params ?? {}),
              );
              const [resource] = resources;
              if (!resource || resources.length !== 1) return [];
              return [
                {
                  pluginId,
                  instanceId,
                  commandId: command.id,
                  resourcePath: resource.path,
                  label: slot.label,
                  generation: active.generation,
                  order: slot.order ?? 0,
                  ...(icon ? { icon } : {}),
                },
              ];
            });
        })
        .sort((a, b) => a.order - b.order)
    );
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
