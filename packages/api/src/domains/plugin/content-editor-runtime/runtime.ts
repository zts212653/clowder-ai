import type { ContentEditorProviderContribution } from '@clowder-ai/plugin-contract';
import { WIRE_VERSION } from '@clowder-ai/plugin-contract';
import type { BuiltinPluginRuntime } from '../builtin-runtime/hybrid-supervisor.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { BuiltinBrokerConnection } from '../host-broker/builtin-loopback.js';
import type { HostBrokerControlPlane } from '../host-broker/control-plane.js';
import type { HostBrokerStore } from '../host-broker/ports.js';
import { StaticFeatureAuthority } from '../host-broker/static-feature-authority.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { staticEditorContributions } from './admission.js';
import { type EditorSurfaceServer, startEditorSurfaceServer } from './surface-server.js';

interface Options {
  readonly inventory: PluginInventoryStore;
  readonly brokerStore: HostBrokerStore;
  readonly broker: HostBrokerControlPlane;
  readonly packages: VerifiedPluginPackageLocator;
  readonly parentOrigin: string;
  readonly now?: () => number;
  readonly onRevoke?: (installationInstanceId: string) => Promise<void>;
}

export interface PluginContentEditorHandle {
  readonly contribution: ContentEditorProviderContribution;
  readonly installationInstanceId: string;
  readonly packageDigest: string;
  readonly providerVersion: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly executionLease: string;
  readonly featureId: string;
  readonly integrityEpoch: number;
  readonly activationRevision: number;
  readonly rendererOrigin: string;
  readonly entrypointPath: string;
  readonly parentOrigin: string;
}

interface ActivePackage {
  readonly packageDigest: string;
  readonly lifecycleRevision: number;
  readonly package: VerifiedPluginPackage;
  readonly connection: BuiltinBrokerConnection;
  readonly servers: Map<string, EditorSurfaceServer>;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  ready: boolean;
}

/** Trusted Host adapter for the admitted static transport class. It imports no
 * package code and exposes no plugin-side bootstrap or effect APIs.
 */
export class ContentEditorPluginRuntime implements BuiltinPluginRuntime {
  readonly features: StaticFeatureAuthority;
  private readonly active = new Map<string, ActivePackage>();
  private readonly starting = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  constructor(private readonly options: Options) {
    this.features = new StaticFeatureAuthority({
      inventory: options.inventory,
      store: options.brokerStore,
      broker: options.broker,
      ...(options.now === undefined ? {} : { now: options.now }),
      verifyActivePackage: async (id, digest) => {
        const run = this.active.get(id);
        if (!run || run.packageDigest !== digest) throw new Error('active package is unavailable');
        await run.package.verifyIntegrity();
      },
    });
  }

  start(id: string): Promise<void> {
    if (this.active.has(id) || this.starting.has(id)) return Promise.reject(new Error('editor already active'));
    const controller = new AbortController();
    const promise = this.activate(id, controller.signal).finally(() => this.starting.delete(id));
    this.starting.set(id, { controller, promise });
    return promise;
  }

  async stop(id: string, reason: string): Promise<void> {
    const pending = this.starting.get(id);
    if (pending) {
      pending.controller.abort();
      await pending.promise.catch(() => undefined);
    }
    await this.close(id, reason);
  }

  async resolve(id: string, providerId: string): Promise<PluginContentEditorHandle | undefined> {
    const run = this.active.get(id);
    if (!run?.ready) return undefined;
    const lease = await this.features.resolve(id, providerId);
    const server = lease && run.servers.get(lease.featureId);
    const contribution = staticEditorContributions(run.package.manifest).find((c) => c.id === providerId);
    if (!lease || !server || !contribution || this.active.get(id) !== run) return undefined;
    return {
      contribution,
      installationInstanceId: id,
      packageDigest: lease.packageRevision,
      providerVersion: run.package.manifest.version,
      grantRevision: lease.grantRevision,
      lifecycleRevision: lease.lifecycleRevision,
      executionLease: lease.executionLease,
      featureId: lease.featureId,
      integrityEpoch: lease.integrityEpoch,
      activationRevision: lease.activationRevision,
      rendererOrigin: server.origin,
      entrypointPath: `${server.pathPrefix}${contribution.surface.entrypoint}`,
      parentOrigin: this.options.parentOrigin,
    };
  }

  private async activate(id: string, signal: AbortSignal): Promise<void> {
    let pkg: VerifiedPluginPackage | undefined;
    let connection: BuiltinBrokerConnection | undefined;
    try {
      const inventory = await this.options.inventory.snapshot();
      const instance = inventory.instances.find((r) => r.pluginInstanceId === id && r.lifecycleState === 'installed');
      const installed = instance && inventory.packages.find((r) => r.packageDigest === instance.packageDigest);
      if (!instance || !installed || staticEditorContributions(installed.manifest).length === 0)
        throw new Error('unsupported static editor');
      pkg = await this.options.packages.resolveInstalledPackage(instance.packageDigest);
      if (JSON.stringify(pkg.manifest) !== JSON.stringify(installed.manifest))
        throw new Error('editor package authority mismatch');
      signal.throwIfAborted();
      connection = await this.options.broker.openBuiltinConnection(id);
      const run: ActivePackage = {
        packageDigest: instance.packageDigest,
        lifecycleRevision: instance.lifecycleRevision,
        package: pkg,
        connection,
        servers: new Map(),
        ready: false,
      };
      this.active.set(id, run);
      const binding = await connection.hello({
        pluginId: pkg.manifest.pluginId,
        packageDigest: instance.packageDigest,
        contractVersion: pkg.manifest.contractVersion,
        wireVersion: WIRE_VERSION,
      });
      signal.throwIfAborted();
      await connection.ready({ bindingNonce: binding.bindingNonce });
      const preferences = (await this.options.brokerStore.snapshot()).staticFeatures?.preferences ?? [];
      for (const feature of pkg.manifest.features) {
        if (preferences.find((r) => r.pluginInstanceId === id && r.featureId === feature.id)?.enabled === false)
          continue;
        const pending = await this.features.begin(id, feature.id);
        signal.throwIfAborted();
        const ids = new Set((feature.contributions ?? []).map((r) => r.id));
        const contributions = staticEditorContributions(pkg.manifest).filter((c) => ids.has(c.id));
        const server = await startEditorSurfaceServer({
          package: pkg,
          contributions,
          parentOrigin: this.options.parentOrigin,
          isCurrent: async () => {
            if (!run.ready || this.active.get(id) !== run) return false;
            try {
              return await this.features.run(pending.executionLease, async () => true);
            } catch {
              return false;
            }
          },
          onFailure: () => {
            void this.fail(id, run).catch(() => undefined);
          },
        });
        run.servers.set(feature.id, server);
        signal.throwIfAborted();
        await this.features.commit(pending.executionLease);
      }
      signal.throwIfAborted();
      await pkg.verifyIntegrity();
      run.ready = true;
      this.scheduleHeartbeat(id, run);
    } catch (error) {
      if (this.active.has(id)) await this.close(id, 'static_editor_start_failed');
      else {
        await connection?.close('static_editor_start_failed');
        await pkg?.release();
      }
      throw error;
    }
  }

  private scheduleHeartbeat(id: string, run: ActivePackage): void {
    run.timer = setTimeout(
      () => {
        void (async () => {
          if (this.active.get(id) !== run) return;
          await run.package.verifyIntegrity();
          await run.connection.renewRuntimeLease();
          if (this.active.get(id) === run) this.scheduleHeartbeat(id, run);
        })()
          .catch(() => this.fail(id, run))
          .catch(() => undefined);
      },
      Math.max(1, Math.floor(this.options.broker.activeRuntimeLeaseTtlMs / 3)),
    );
    run.timer.unref();
  }

  private async fail(id: string, run: ActivePackage): Promise<void> {
    if (this.active.get(id) !== run) return;
    const pending = this.starting.get(id);
    if (pending) {
      pending.controller.abort();
      await pending.promise.catch(() => undefined);
    }
    if (this.active.has(id) && this.active.get(id) !== run) return;
    await this.close(id, 'static_editor_runtime_failed');
    await this.options.inventory.transaction((tx) => {
      const current = tx.instances.get(id);
      if (
        current?.packageDigest === run.packageDigest &&
        current.lifecycleRevision === run.lifecycleRevision &&
        current.activationState === 'enabled' &&
        !this.active.has(id)
      ) {
        tx.instances.put({ ...current, runtimeState: 'crashed', updatedAt: (this.options.now ?? Date.now)() });
      }
    });
  }

  private async close(id: string, reason: string): Promise<void> {
    const run = this.active.get(id);
    if (!run) return;
    run.closing ??= this.closeRun(id, run, reason);
    await run.closing;
  }

  private async closeRun(id: string, run: ActivePackage, reason: string): Promise<void> {
    run.ready = false;
    // Broker close durably revokes every bound feature before surface cleanup.
    await run.connection.close(reason);
    clearTimeout(run.timer);
    try {
      await this.options.onRevoke?.(id);
    } finally {
      try {
        await Promise.all([...run.servers.values()].map((server) => server.close()));
      } finally {
        try {
          await run.package.release();
        } finally {
          if (this.active.get(id) === run) this.active.delete(id);
        }
      }
    }
  }
}
