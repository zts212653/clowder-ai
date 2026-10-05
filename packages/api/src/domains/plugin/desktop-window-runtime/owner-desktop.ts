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
        (instance.runtimeState !== 'crashed' && !hasRetainedDesktopLoss(instance)) ||
        pkg?.packageState !== 'installed' ||
        !desktopWindowContribution(pkg.manifest)
      )
        throw new Error('desktop recovery unavailable');
      // Repair owns the revision CAS, durable close, fresh grant/package checks
      // and new Broker/feature generation. No call or media is restored here.
      await lifecycle.repair(instance.pluginInstanceId, instance.lifecycleRevision);
    }
    await desktop.show();
  }
}
