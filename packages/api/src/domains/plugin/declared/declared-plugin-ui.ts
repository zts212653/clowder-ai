import { randomUUID } from 'node:crypto';
import type { PluginIconSpec } from '@cat-cafe/shared';
import type { UiCommandContribution, UiSlotItemContribution } from '@clowder-ai/plugin-contract';
import { currentPluginOwnerRequestContext, withPluginOwnerWebhook } from '../carrier/plugin-owner-request-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

export interface PluginUiEntry {
  instanceId: string;
  commandId: string;
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
}
/** Uses existing public ui command/slot-item declarations; no package-specific router. */
export class DeclaredPluginUi {
  readonly #active = new Map<string, Active>();
  constructor(private readonly invoke: (instanceId: string, method: string, input: unknown) => Promise<unknown>) {}

  activate(admission: PluginRuntimeAdmission): void {
    const id = admission.instance.pluginInstanceId;
    this.deactivate(id);
    const contributions = admission.packageRecord.manifest.contributions ?? [];
    this.#active.set(id, {
      admission,
      generation: randomUUID(),
      lifetime: new AbortController(),
      commands: contributions.filter((c): c is UiCommandContribution => c.type === 'ui' && c.kind === 'command'),
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
  list(): PluginUiEntry[] {
    return [...this.#active]
      .flatMap(([instanceId, active]) =>
        active.slots.flatMap((slot) => {
          const command = active.commands.find((c) => c.id === slot.command);
          return command
            ? [
                {
                  instanceId,
                  commandId: command.id,
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
  async call(instanceId: string, commandId: string, generation: string, input: unknown): Promise<unknown> {
    const active = this.#active.get(instanceId);
    const command = active?.commands.find((c) => c.id === commandId);
    if (!active || !command || active.generation !== generation || !active.slots.some((s) => s.command === commandId))
      throw new Error('Plugin UI is no longer active');
    const assertActivation = () => {
      if (this.#active.get(instanceId) !== active) throw new Error('Plugin UI activation expired');
    };
    return withPluginOwnerWebhook(
      active.admission.packageRecord.pluginId,
      commandId,
      instanceId,
      false,
      assertActivation,
      async () => {
        const owner = currentPluginOwnerRequestContext(instanceId);
        if (!owner || !owner.requestIdentity) throw new Error('Plugin UI requires an owner request');
        await owner.assertCurrent();
        return this.invoke(instanceId, command.action.method, input);
      },
      active.lifetime.signal,
    );
  }
  pluginId(instanceId: string): string | undefined {
    return this.#active.get(instanceId)?.admission.packageRecord.pluginId;
  }
}
