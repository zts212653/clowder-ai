import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Capability } from '@clowder-ai/plugin-contract';
import { type VerifiedPackageAdmission, verifyPackageAdmission } from './manifest-verifier.js';
import type { PluginInventoryStore, PluginInventoryTransaction } from './ports.js';
import type {
  InventoryMutationResult,
  PackageAdmissionCandidate,
  PluginGrantRecord,
  PluginInstanceRecord,
  ReinstallPackageInput,
  RevokeGrantInput,
  UpgradePackageInput,
} from './types.js';
import { PluginInventoryError } from './types.js';

export interface HostInventoryControlPlaneOptions {
  readonly now?: () => number;
  readonly createInstanceId?: () => string;
}

function assertCurrentInstance(
  transaction: PluginInventoryTransaction,
  pluginInstanceId: string,
): PluginInstanceRecord {
  const instance = transaction.instances.get(pluginInstanceId);
  if (!instance) throw new PluginInventoryError('INSTANCE_NOT_FOUND', `unknown plugin instance ${pluginInstanceId}`);
  const current = transaction.instances.getCurrent(instance.pluginId);
  if (instance.lifecycleState !== 'installed' || current?.pluginInstanceId !== pluginInstanceId) {
    throw new PluginInventoryError('STALE_INSTANCE', `plugin instance ${pluginInstanceId} is not current`);
  }
  return instance;
}

function assertGrantRevision(grants: PluginGrantRecord, expectedGrantRevision: number): void {
  if (grants.grantRevision !== expectedGrantRevision) {
    throw new PluginInventoryError(
      'STALE_GRANT_REVISION',
      `expected grant revision ${expectedGrantRevision}, current ${grants.grantRevision}`,
    );
  }
}

function putVerifiedPackage(transaction: PluginInventoryTransaction, verified: VerifiedPackageAdmission): void {
  const existing = transaction.packages.get(verified.package.packageDigest);
  if (!existing) {
    transaction.packages.put(verified.package);
    return;
  }
  if (
    existing.pluginId !== verified.package.pluginId ||
    existing.version !== verified.package.version ||
    !isDeepStrictEqual(existing.manifest, verified.package.manifest)
  ) {
    throw new PluginInventoryError(
      'PACKAGE_DIGEST_MISMATCH',
      'an immutable digest is already bound to another package',
    );
  }
}

function createInstance(
  pluginInstanceId: string,
  pluginId: string,
  packageDigest: string,
  now: number,
): PluginInstanceRecord {
  return {
    pluginInstanceId,
    pluginId,
    packageDigest,
    lifecycleState: 'installed',
    configReadiness: 'incomplete',
    activationState: 'disabled',
    runtimeState: 'stopped',
    installedAt: now,
    updatedAt: now,
  };
}

function createGrant(pluginInstanceId: string, verified: VerifiedPackageAdmission, now: number): PluginGrantRecord {
  return {
    pluginInstanceId,
    requestedCapabilities: verified.requestedCapabilities,
    effectiveGrants: verified.effectiveGrants,
    grantRevision: 1,
    updatedAt: now,
  };
}

export class HostInventoryControlPlane {
  constructor(
    readonly store: PluginInventoryStore,
    readonly options: HostInventoryControlPlaneOptions = {},
  ) {}

  async installPackage(input: PackageAdmissionCandidate): Promise<InventoryMutationResult> {
    const now = this.now();
    const verified = verifyPackageAdmission(input, now);
    const pluginInstanceId = this.createInstanceId();
    return this.store.transaction((transaction) => {
      if (transaction.instances.getCurrent(verified.package.pluginId)) {
        throw new PluginInventoryError(
          'PACKAGE_ALREADY_INSTALLED',
          `${verified.package.pluginId} is already installed`,
        );
      }
      if (transaction.instances.get(pluginInstanceId)) {
        throw new PluginInventoryError(
          'INSTANCE_ID_COLLISION',
          `plugin instance id ${pluginInstanceId} already exists`,
        );
      }
      putVerifiedPackage(transaction, verified);
      transaction.instances.put(
        createInstance(pluginInstanceId, verified.package.pluginId, input.computedPackageDigest, now),
      );
      transaction.grants.put(createGrant(pluginInstanceId, verified, now));
      return { pluginInstanceId, packageDigest: input.computedPackageDigest, grantRevision: 1 };
    });
  }

  async upgradePackage(input: UpgradePackageInput): Promise<InventoryMutationResult> {
    const now = this.now();
    const verified = verifyPackageAdmission(input, now);
    return this.store.transaction((transaction) => {
      const current = assertCurrentInstance(transaction, input.pluginInstanceId);
      if (current.pluginId !== verified.package.pluginId) {
        throw new PluginInventoryError(
          'PACKAGE_ID_MISMATCH',
          'upgrade package does not belong to the current instance',
        );
      }
      const grants = transaction.grants.get(current.pluginInstanceId);
      if (!grants) throw new PluginInventoryError('INVENTORY_INVARIANT', 'current instance has no grant record');
      assertGrantRevision(grants, input.expectedGrantRevision);
      putVerifiedPackage(transaction, verified);
      transaction.instances.put({
        ...current,
        packageDigest: input.computedPackageDigest,
        activationState: 'disabled',
        runtimeState: 'stopped',
        updatedAt: now,
      });
      // The package manifest is the authority basis, so every upgrade advances the grant fence.
      const grantRevision = grants.grantRevision + 1;
      transaction.grants.put({
        ...grants,
        requestedCapabilities: verified.requestedCapabilities,
        effectiveGrants: verified.effectiveGrants,
        grantRevision,
        updatedAt: now,
      });
      return {
        pluginInstanceId: current.pluginInstanceId,
        packageDigest: input.computedPackageDigest,
        grantRevision,
      };
    });
  }

  async reinstallPackage(input: ReinstallPackageInput): Promise<InventoryMutationResult> {
    const now = this.now();
    const verified = verifyPackageAdmission(input, now);
    const nextInstanceId = this.createInstanceId();
    return this.store.transaction((transaction) => {
      const current = assertCurrentInstance(transaction, input.previousPluginInstanceId);
      if (current.pluginId !== verified.package.pluginId) {
        throw new PluginInventoryError(
          'PACKAGE_ID_MISMATCH',
          'reinstall package does not belong to the current instance',
        );
      }
      if (transaction.instances.get(nextInstanceId)) {
        throw new PluginInventoryError('INSTANCE_ID_COLLISION', `plugin instance id ${nextInstanceId} already exists`);
      }
      putVerifiedPackage(transaction, verified);
      transaction.instances.put({
        ...current,
        lifecycleState: 'retired',
        activationState: 'disabled',
        runtimeState: 'stopped',
        retiredAt: now,
        updatedAt: now,
      });
      transaction.instances.put(createInstance(nextInstanceId, current.pluginId, input.computedPackageDigest, now));
      transaction.grants.put(createGrant(nextInstanceId, verified, now));
      return { pluginInstanceId: nextInstanceId, packageDigest: input.computedPackageDigest, grantRevision: 1 };
    });
  }

  async revokeGrant(input: RevokeGrantInput): Promise<number> {
    return this.store.transaction((transaction) => {
      assertCurrentInstance(transaction, input.pluginInstanceId);
      const grants = transaction.grants.get(input.pluginInstanceId);
      if (!grants) throw new PluginInventoryError('INVENTORY_INVARIANT', 'current instance has no grant record');
      assertGrantRevision(grants, input.expectedGrantRevision);
      if (!grants.requestedCapabilities.includes(input.capability as Capability)) {
        throw new PluginInventoryError('INVALID_GRANT', `${input.capability} is not requested by this plugin`);
      }
      if (!grants.effectiveGrants.includes(input.capability as Capability)) return grants.grantRevision;
      const now = this.now();
      const effectiveGrants = grants.effectiveGrants.filter((capability) => capability !== input.capability);
      const grantRevision = grants.grantRevision + 1;
      transaction.grants.put({ ...grants, effectiveGrants, grantRevision, updatedAt: now });
      return grantRevision;
    });
  }

  async recoverAfterRestart(): Promise<number> {
    const now = this.now();
    return this.store.transaction((transaction) => {
      let changed = 0;
      for (const instance of transaction.instances.list()) {
        const activationInterrupted =
          instance.activationState === 'enabling' || instance.activationState === 'disabling';
        if (instance.runtimeState === 'stopped' && !activationInterrupted) continue;
        transaction.instances.put({
          ...instance,
          activationState: activationInterrupted ? 'error' : instance.activationState,
          runtimeState: 'stopped',
          updatedAt: now,
        });
        changed += 1;
      }
      return changed;
    });
  }

  protected now(): number {
    return this.options.now?.() ?? Date.now();
  }

  protected createInstanceId(): string {
    return this.options.createInstanceId?.() ?? `pi_${randomUUID()}`;
  }
}
