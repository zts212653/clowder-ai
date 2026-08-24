import { resolve } from 'node:path';
import type { MeetingIntakeStore } from '../signal-intake/MeetingIntakeStore.js';
import type { SignalRouteStore } from '../signal-intake/SignalRouteStore.js';
import { ExternalPluginLifecycleService } from './external-plugin-lifecycle.js';
import { FilesystemVerifiedPluginPackageLocator } from './external-runtime/filesystem-package-locator.js';
import { ExternalPluginRuntimeSupervisor } from './external-runtime/supervisor.js';
import type { ExternalPluginProcessAdapter, VerifiedPluginPackageLocator } from './external-runtime/types.js';
import { HostBrokerControlPlane } from './host-broker/control-plane.js';
import { createEventsPublishBrokerHandler } from './host-broker/events-publish-handler.js';
import { FileHostBrokerStore } from './host-broker/stores.js';
import { HostInventoryControlPlane } from './host-inventory/control-plane.js';
import { FilePluginInventoryStore } from './host-inventory/stores.js';

export interface PluginRuntimePersistencePaths {
  readonly inventorySnapshotPath: string;
  readonly brokerSnapshotPath: string;
  readonly packagesRoot: string;
}

export interface DormantPluginRuntimeCompositionOptions {
  readonly projectRoot: string;
  readonly paths?: PluginRuntimePersistencePaths;
  readonly routes: SignalRouteStore;
  readonly intakes: MeetingIntakeStore;
  readonly processes?: ExternalPluginProcessAdapter;
  readonly packages?: VerifiedPluginPackageLocator;
  readonly now?: () => number;
}

export interface DormantPluginRuntimeRecovery {
  readonly brokerSessions: number;
  readonly inventoryInstances: number;
  readonly resumeRequested: number;
}

export interface DormantPluginRuntimeComposition {
  readonly paths: PluginRuntimePersistencePaths;
  readonly inventoryStore: FilePluginInventoryStore;
  readonly brokerStore: FileHostBrokerStore;
  readonly inventory: HostInventoryControlPlane;
  readonly broker: HostBrokerControlPlane;
  readonly supervisor: ExternalPluginRuntimeSupervisor;
  readonly lifecycle: ExternalPluginLifecycleService;
  readonly packages: VerifiedPluginPackageLocator;
  recoverAfterRestart(): Promise<DormantPluginRuntimeRecovery>;
  shutdown(reason?: string): Promise<void>;
}

// External runtimes must finish their own bounded source-readiness checks before
// broker.ready. The published Feishu intake can spend up to 30 seconds on each
// event source and lark-cli read command, so the Host policy must cover that
// honest startup path while remaining bounded.
export const EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS = 4 * 60_000;

export function resolvePluginRuntimePersistencePaths(projectRoot: string): PluginRuntimePersistencePaths {
  const root = resolve(projectRoot, '.cat-cafe', 'plugin-host');
  return {
    inventorySnapshotPath: resolve(root, 'inventory.json'),
    brokerSnapshotPath: resolve(root, 'broker.json'),
    packagesRoot: resolve(root, 'packages'),
  };
}

function normalizePaths(paths: PluginRuntimePersistencePaths): PluginRuntimePersistencePaths {
  return {
    inventorySnapshotPath: resolve(paths.inventorySnapshotPath),
    brokerSnapshotPath: resolve(paths.brokerSnapshotPath),
    packagesRoot: resolve(paths.packagesRoot),
  };
}

export function createDormantPluginRuntimeComposition(
  options: DormantPluginRuntimeCompositionOptions,
): DormantPluginRuntimeComposition {
  const paths = options.paths
    ? normalizePaths(options.paths)
    : resolvePluginRuntimePersistencePaths(options.projectRoot);
  const inventoryStore = new FilePluginInventoryStore(paths.inventorySnapshotPath);
  const brokerStore = new FileHostBrokerStore(paths.brokerSnapshotPath);
  const inventory = new HostInventoryControlPlane(inventoryStore, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const broker = new HostBrokerControlPlane({
    inventory: inventoryStore,
    store: brokerStore,
    methods: [
      createEventsPublishBrokerHandler({
        inventory: inventoryStore,
        brokerStore,
        routes: options.routes,
        intakes: options.intakes,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    ],
    preActiveTimeoutMs: EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const packages = options.packages ?? new FilesystemVerifiedPluginPackageLocator(paths.packagesRoot);
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: inventoryStore,
    broker,
    packages,
    handshakeTimeoutMs: EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS,
    ...(options.processes === undefined ? {} : { processes: options.processes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const lifecycle = new ExternalPluginLifecycleService({
    store: inventoryStore,
    supervisor,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    paths,
    inventoryStore,
    brokerStore,
    inventory,
    broker,
    supervisor,
    lifecycle,
    packages,
    async recoverAfterRestart() {
      await Promise.all([inventoryStore.snapshot(), brokerStore.snapshot()]);
      const brokerSessions = await supervisor.recoverAfterRestart();
      const inventoryRecovery = await lifecycle.recoverAfterRestart();
      return {
        brokerSessions,
        inventoryInstances: inventoryRecovery.recoveredInstances,
        resumeRequested: inventoryRecovery.resumeRequested,
      };
    },
    shutdown: (reason = 'host_shutdown') => supervisor.stopAll(reason),
  };
}
