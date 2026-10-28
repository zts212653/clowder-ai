import type { ExternalPluginLifecycleService } from '../external-plugin-lifecycle.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { desktopWindowContribution } from './admission.js';
import { hasRetainedDesktopLoss } from './desktop-loss.js';
import type { DesktopWindowPluginRuntime } from './runtime.js';

interface Options {
  readonly inventory: PluginInventoryStore;
  readonly lifecycle: Pick<ExternalPluginLifecycleService, 'repair'>;
  readonly desktop: DesktopWindowPluginRuntime;
}

/** The selector-free owner click reuses lifecycle repair; reads and timers never restart a body. */
export class OwnerDesktop {
  private showing?: Promise<void>;

  constructor(private readonly options: Options) {}

  presence() {
    return this.options.desktop.presence();
  }

  unexpectedLossId() {
    return this.options.desktop.unexpectedLossId();
  }

  show(): Promise<void> {
    if (this.showing) return this.showing;
    const operation = this.showCurrentOrRepair().finally(() => {
      if (this.showing === operation) this.showing = undefined;
    });
    this.showing = operation;
    return operation;
  }

  private async showCurrentOrRepair(): Promise<void> {
    const { desktop, inventory, lifecycle } = this.options;
    if (!(await desktop.presence())) {
      const snapshot = await inventory.snapshot();
      const candidates = snapshot.instances.filter(
        (instance) => instance.pluginId === 'official.companion' && instance.lifecycleState === 'installed',
      );
      const instance = candidates[0];
      const pkg = instance && snapshot.packages.find((record) => record.packageDigest === instance.packageDigest);
      if (
        candidates.length !== 1 ||
        !instance ||
        instance.activationState !== 'enabled' ||
        instance.configReadiness !== 'ready' ||
        (instance.runtimeState !== 'healthy' &&
          instance.runtimeState !== 'crashed' &&
          !hasRetainedDesktopLoss(instance)) ||
        pkg?.packageState !== 'installed' ||
        pkg.manifest === null ||
        !desktopWindowContribution(pkg.manifest)
      )
        throw new Error('desktop recovery unavailable');
      // A healthy body can have an observation still pending behind Host IO;
      // show waits for it under current authority. Only retained loss repairs.
      // Repair retains its revision CAS and fresh package/activation checks.
      if (instance.runtimeState !== 'healthy')
        await lifecycle.repair(instance.pluginInstanceId, instance.lifecycleRevision);
    }
    await desktop.show();
  }
}
