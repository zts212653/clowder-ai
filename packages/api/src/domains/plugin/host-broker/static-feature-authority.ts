import { randomUUID } from 'node:crypto';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { HostBrokerControlPlane } from './control-plane.js';
import type { HostBrokerStore, HostBrokerTransaction } from './ports.js';
import { containStaticFeatureEpoch, revokeStaticFeatures, type StaticFeatureLease } from './static-feature-ledger.js';
import type { BrokerCallContext } from './types.js';
import { HostBrokerError } from './types.js';

interface Options {
  readonly inventory: PluginInventoryStore;
  readonly store: HostBrokerStore;
  readonly broker: HostBrokerControlPlane;
  /** The runtime owns the verified, private tree; candidates cannot supply this verifier. */
  readonly verifyActivePackage: (pluginInstanceId: string, packageDigest: string) => Promise<void>;
  readonly now?: () => number;
}

type Decision<T> = { value: T } | { error: HostBrokerError };
const denied = (message: string) => new HostBrokerError('AUTHORITY_CHANGED', message);

/** Host-owned activation for declarative static features, with no bootstrap/effect APIs.
 * Package code is never imported. General Train B callbacks/state/settlement tokens are
 * outside this admission class; they cannot be requested through this authority.
 */
export class StaticFeatureAuthority {
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  async begin(pluginInstanceId: string, featureId: string): Promise<StaticFeatureLease> {
    const binding = await this.options.broker.authorizeStaticFeature(pluginInstanceId);
    const decision = await this.options.store.transaction((tx) =>
      this.options.inventory.transaction(async (inventory): Promise<Decision<StaticFeatureLease>> => {
        const { instance, manifest } = this.current(tx, inventory, binding);
        this.declarations(manifest, featureId);
        const ledger = tx.staticFeatures.get();
        const desired = ledger.preferences.find(
          (r) => r.pluginInstanceId === pluginInstanceId && r.featureId === featureId,
        );
        if (desired?.enabled === false) throw denied('feature is disabled');
        if (
          ledger.leases.some(
            (r) => r.pluginInstanceId === pluginInstanceId && r.featureId === featureId && r.state !== 'revoked',
          )
        ) {
          throw denied('feature already has an activation');
        }
        const previous = ledger.leases.filter((r) => r.pluginInstanceId === pluginInstanceId);
        const sessionEpoch = previous.find((r) => r.brokerSessionId === binding.brokerSessionId)?.integrityEpoch;
        let epoch = ledger.epochs.find(
          (r) => r.pluginInstanceId === pluginInstanceId && r.integrityEpoch === sessionEpoch,
        );
        if (epoch?.state === 'damaged') throw denied('package integrity epoch is damaged');
        try {
          await this.options.verifyActivePackage(pluginInstanceId, binding.packageDigest);
        } catch {
          if (epoch)
            tx.staticFeatures.put(
              containStaticFeatureEpoch(ledger, pluginInstanceId, epoch.integrityEpoch, this.now()),
            );
          return { error: denied('package integrity is untrusted') };
        }
        if (!epoch) {
          epoch = {
            pluginInstanceId,
            packageRevision: binding.packageDigest,
            integrityEpoch:
              Math.max(
                0,
                ...ledger.epochs.filter((r) => r.pluginInstanceId === pluginInstanceId).map((r) => r.integrityEpoch),
              ) + 1,
            state: 'verified',
          };
          ledger.epochs.push(epoch);
        }
        const record: StaticFeatureLease = {
          executionLease: `feature_${randomUUID()}`,
          pluginInstanceId,
          featureId,
          packageRevision: binding.packageDigest,
          integrityEpoch: epoch.integrityEpoch,
          activationRevision:
            Math.max(0, ...previous.filter((r) => r.featureId === featureId).map((r) => r.activationRevision)) + 1,
          lifecycleRevision: instance.lifecycleRevision,
          grantRevision: binding.grantRevision,
          grantedCapabilities: [],
          connectionId: binding.connectionId,
          brokerSessionId: binding.brokerSessionId,
          runtimeLeaseId: binding.runtimeLeaseId,
          state: 'provisioning',
          contributionIds: [],
          updatedAt: this.now(),
        };
        if (!desired) ledger.preferences.push({ pluginInstanceId, featureId, enabled: true });
        ledger.leases.push(record);
        tx.staticFeatures.put(ledger);
        return { value: structuredClone(record) };
      }),
    );
    if ('error' in decision) throw decision.error;
    return decision.value;
  }

  commit(executionLease: string): Promise<StaticFeatureLease> {
    return this.withLease(executionLease, 'provisioning', async (record, tx, inventory) => {
      const manifest = inventory.packages.get(record.packageRevision)!.manifest;
      const live = {
        ...record,
        state: 'active' as const,
        contributionIds: this.declarations(manifest, record.featureId),
        updatedAt: this.now(),
      };
      const ledger = tx.staticFeatures.get();
      ledger.leases = ledger.leases.map((r) => (r.executionLease === executionLease ? live : r));
      tx.staticFeatures.put(ledger);
      return structuredClone(live);
    });
  }

  /** Keep revocation and owner-effect linearization in order, including inventory CAS.
   * Work must not re-enter either Host store. Only trusted Host consumers receive this port.
   */
  run<T>(executionLease: string, work: (lease: StaticFeatureLease) => Promise<T>): Promise<T> {
    return this.withLease(executionLease, 'active', (record) => work(structuredClone(record)));
  }

  async resolve(pluginInstanceId: string, providerId: string): Promise<StaticFeatureLease | null> {
    const record = (await this.options.store.snapshot()).staticFeatures?.leases.find(
      (r) => r.pluginInstanceId === pluginInstanceId && r.state === 'active' && r.contributionIds.includes(providerId),
    );
    if (!record) return null;
    try {
      return await this.run(record.executionLease, async (live) => live);
    } catch (error) {
      if (error instanceof HostBrokerError) return null;
      throw error;
    }
  }

  async setDesired(pluginInstanceId: string, featureId: string, enabled: boolean): Promise<void> {
    await this.options.store.transaction((tx) =>
      this.options.inventory.transaction((inventory) => {
        const instance = inventory.instances.get(pluginInstanceId);
        const manifest = instance && inventory.packages.get(instance.packageDigest)?.manifest;
        if (!instance || instance.lifecycleState !== 'installed' || !manifest)
          throw denied('instance is not installed');
        this.declarations(manifest, featureId);
        const ledger = tx.staticFeatures.get();
        ledger.preferences = ledger.preferences.filter(
          (r) => r.pluginInstanceId !== pluginInstanceId || r.featureId !== featureId,
        );
        ledger.preferences.push({ pluginInstanceId, featureId, enabled });
        tx.staticFeatures.put(
          enabled
            ? ledger
            : revokeStaticFeatures(
                ledger,
                (r) => r.pluginInstanceId === pluginInstanceId && r.featureId === featureId,
                this.now(),
              ),
        );
      }),
    );
  }

  private async withLease<T>(
    executionLease: string,
    phase: 'provisioning' | 'active',
    work: (lease: StaticFeatureLease, tx: HostBrokerTransaction, inventory: PluginInventoryTransaction) => Promise<T>,
  ): Promise<T> {
    const decision = await this.options.store.transaction((tx) =>
      this.options.inventory.transaction(async (inventory): Promise<Decision<T>> => {
        const ledger = tx.staticFeatures.get();
        const record = ledger.leases.find((r) => r.executionLease === executionLease);
        if (!record || record.state === 'revoked') return { error: denied('feature lease is revoked or unknown') };
        if (record.state !== phase) return { error: denied(`feature lease is not ${phase}`) };
        try {
          const { instance } = this.current(tx, inventory, {
            ...record,
            packageDigest: record.packageRevision,
          });
          const desired = ledger.preferences.find(
            (r) => r.pluginInstanceId === record.pluginInstanceId && r.featureId === record.featureId,
          );
          const epoch = ledger.epochs.find(
            (r) => r.pluginInstanceId === record.pluginInstanceId && r.integrityEpoch === record.integrityEpoch,
          );
          if (
            !desired?.enabled ||
            epoch?.state !== 'verified' ||
            instance.lifecycleRevision !== record.lifecycleRevision
          ) {
            throw denied('feature authority changed');
          }
        } catch (error) {
          tx.staticFeatures.put(revokeStaticFeatures(ledger, (r) => r.executionLease === executionLease, this.now()));
          return { error: error instanceof HostBrokerError ? error : denied('feature authority changed') };
        }
        try {
          await this.options.verifyActivePackage(record.pluginInstanceId, record.packageRevision);
        } catch {
          tx.staticFeatures.put(
            containStaticFeatureEpoch(ledger, record.pluginInstanceId, record.integrityEpoch, this.now()),
          );
          return { error: denied('package integrity is untrusted') };
        }
        return { value: await work(record, tx, inventory) };
      }),
    );
    if ('error' in decision) throw decision.error;
    return decision.value;
  }

  private current(
    tx: HostBrokerTransaction,
    inventory: PluginInventoryTransaction,
    binding: Pick<
      BrokerCallContext,
      'pluginInstanceId' | 'connectionId' | 'brokerSessionId' | 'runtimeLeaseId' | 'packageDigest' | 'grantRevision'
    >,
  ) {
    const session = tx.sessions.getByConnectionId(binding.connectionId);
    const runtime = tx.runtimeLeases.get(binding.runtimeLeaseId);
    const instance = inventory.instances.get(binding.pluginInstanceId);
    const pkg = instance && inventory.packages.get(instance.packageDigest);
    const grants = inventory.grants.get(binding.pluginInstanceId);
    if (
      !session ||
      session.phase !== 'active' ||
      session.brokerSessionId !== binding.brokerSessionId ||
      session.pluginInstanceId !== binding.pluginInstanceId ||
      session.packageDigest !== binding.packageDigest ||
      session.grantRevision !== binding.grantRevision ||
      session.runtimeLeaseId !== binding.runtimeLeaseId ||
      session.activeLeaseExpiresAt === undefined ||
      session.activeLeaseExpiresAt <= this.now() ||
      !runtime ||
      runtime.state !== 'live' ||
      runtime.expiresAt <= this.now() ||
      runtime.brokerSessionId !== binding.brokerSessionId ||
      runtime.pluginInstanceId !== binding.pluginInstanceId ||
      runtime.packageDigest !== binding.packageDigest ||
      runtime.grantRevision !== binding.grantRevision ||
      !instance ||
      inventory.instances.getCurrent(instance.pluginId)?.pluginInstanceId !== instance.pluginInstanceId ||
      instance.lifecycleState !== 'installed' ||
      instance.activationState !== 'enabled' ||
      instance.configReadiness !== 'ready' ||
      instance.runtimeState !== 'healthy' ||
      instance.packageDigest !== binding.packageDigest ||
      pkg?.packageState !== 'installed' ||
      grants?.grantRevision !== binding.grantRevision ||
      grants.effectiveGrants.length !== 0
    ) {
      throw denied('static feature has no current Host authority');
    }
    return { instance, manifest: pkg.manifest };
  }

  private declarations(manifest: PluginManifest, featureId: string): string[] {
    const feature = manifest.features.find((r) => r.id === featureId);
    if (!feature || feature.resources.length !== 0 || feature.capabilities.length !== 0) {
      throw denied('feature is not a declared zero-capability static feature');
    }
    const references = feature.contributions ?? [];
    if (references.some((r) => r.type !== 'content-editor-provider'))
      throw denied('unsupported static feature contribution');
    return references.map((r) => r.id);
  }
}
