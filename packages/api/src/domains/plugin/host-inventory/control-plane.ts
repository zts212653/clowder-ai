import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isHostReservedDataDirectoryName, requestedDataDirectoryName } from './data-directory-name.js';
import {
  type PackageAdmissionContractRuntime,
  type VerifiedPackageAdmission,
  verifyPackageAdmission,
} from './manifest-verifier.js';
import type { PluginInventoryStore, PluginInventoryTransaction } from './ports.js';
import { normalizePluginInstanceAfterRestart } from './restart-recovery.js';
import type {
  InventoryMutationResult,
  PackageAdmissionCandidate,
  PluginInstanceRecord,
  ReinstallPackageInput,
  UpgradePackageInput,
} from './types.js';
import { PluginInventoryError } from './types.js';

export interface HostInventoryControlPlaneOptions {
  readonly now?: () => number;
  readonly createInstanceId?: () => string;
  readonly contract?: PackageAdmissionContractRuntime;
}

async function assertCurrentInstance(
  transaction: PluginInventoryTransaction,
  pluginInstanceId: string,
): Promise<PluginInstanceRecord> {
  const instance = await transaction.instances.get(pluginInstanceId);
  if (!instance) throw new PluginInventoryError('INSTANCE_NOT_FOUND', `unknown plugin instance ${pluginInstanceId}`);
  const current = await transaction.instances.getCurrent(instance.pluginId);
  if (instance.lifecycleState !== 'installed' || current?.pluginInstanceId !== pluginInstanceId) {
    throw new PluginInventoryError('STALE_INSTANCE', `plugin instance ${pluginInstanceId} is not current`);
  }
  return instance;
}

function assertLifecycleRevision(instance: PluginInstanceRecord, expectedLifecycleRevision: number): void {
  if (instance.lifecycleRevision !== expectedLifecycleRevision) {
    throw new PluginInventoryError(
      'STALE_LIFECYCLE_REVISION',
      `expected lifecycle revision ${expectedLifecycleRevision}, current ${instance.lifecycleRevision}`,
    );
  }
}

/**
 * F202 W2-3 h2: two installed plugins never share one data directory. Every admission (install,
 * upgrade, reinstall) writes its package through putVerifiedPackage, so the check sits there.
 */
async function assertDataDirectoryFree(
  transaction: PluginInventoryTransaction,
  verified: VerifiedPackageAdmission,
): Promise<void> {
  const name = requestedDataDirectoryName(verified.package.manifest);
  if (name === undefined) return;
  if (isHostReservedDataDirectoryName(name)) {
    throw new PluginInventoryError(
      'DATA_DIRECTORY_IN_USE',
      `data directory ${name} is reserved for the Host's own files`,
    );
  }
  for (const instance of await transaction.instances.list(undefined, 'installed')) {
    if (instance.lifecycleState !== 'installed' || instance.pluginId === verified.package.pluginId) continue;
    const holderPackage = await transaction.packages.get(instance.packageDigest);
    const holder = holderPackage?.manifest ?? holderPackage?.incompatibleManifest;
    if (holder !== undefined && requestedDataDirectoryName(holder) === name) {
      throw new PluginInventoryError(
        'DATA_DIRECTORY_IN_USE',
        `data directory ${name} is already used by the installed plugin ${instance.pluginId}`,
      );
    }
  }
}

async function putVerifiedPackage(
  transaction: PluginInventoryTransaction,
  verified: VerifiedPackageAdmission,
): Promise<void> {
  await assertDataDirectoryFree(transaction, verified);
  const existing = await transaction.packages.get(verified.package.packageDigest);
  if (!existing) {
    await transaction.packages.put(verified.package);
    return;
  }
  if (
    existing.pluginId !== verified.package.pluginId ||
    existing.version !== verified.package.version ||
    !isDeepStrictEqual(existing.manifest, verified.package.manifest) ||
    !isDeepStrictEqual(existing.signalSchemas, verified.package.signalSchemas) ||
    (existing.agentClientMetadata !== undefined &&
      verified.package.agentClientMetadata !== undefined &&
      !isDeepStrictEqual(existing.agentClientMetadata, verified.package.agentClientMetadata))
  ) {
    throw new PluginInventoryError(
      'PACKAGE_DIGEST_MISMATCH',
      'an immutable digest is already bound to another package',
    );
  }
  if (existing.agentClientMetadata === undefined && verified.package.agentClientMetadata !== undefined)
    await transaction.packages.put({ ...existing, agentClientMetadata: verified.package.agentClientMetadata });
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
    lifecycleRevision: 1,
    installedAt: now,
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
    const verified = await this.verify(input, now);
    const pluginInstanceId = this.createInstanceId();
    return this.store.transaction(async (transaction) => {
      if (await transaction.instances.getCurrent(verified.package.pluginId)) {
        throw new PluginInventoryError(
          'PACKAGE_ALREADY_INSTALLED',
          `${verified.package.pluginId} is already installed`,
        );
      }
      if (await transaction.instances.get(pluginInstanceId)) {
        throw new PluginInventoryError(
          'INSTANCE_ID_COLLISION',
          `plugin instance id ${pluginInstanceId} already exists`,
        );
      }
      await putVerifiedPackage(transaction, verified);
      await transaction.instances.put(
        createInstance(pluginInstanceId, verified.package.pluginId, input.computedPackageDigest, now),
      );
      return { pluginInstanceId, packageDigest: input.computedPackageDigest };
    });
  }

  async upgradePackage(input: UpgradePackageInput): Promise<InventoryMutationResult> {
    const now = this.now();
    const verified = await this.verify(input, now);
    return this.store.transaction(async (transaction) => {
      const current = await assertCurrentInstance(transaction, input.pluginInstanceId);
      assertLifecycleRevision(current, input.expectedLifecycleRevision);
      if (current.pluginId !== verified.package.pluginId) {
        throw new PluginInventoryError(
          'PACKAGE_ID_MISMATCH',
          'upgrade package does not belong to the current instance',
        );
      }
      if (
        !['stopped', 'crashed'].includes(current.runtimeState) ||
        current.activationState === 'enabling' ||
        current.activationState === 'disabling'
      ) {
        throw new PluginInventoryError('RUNTIME_NOT_STOPPED', 'package mutation requires a stable stopped runtime');
      }
      const incompatible = (await transaction.packages.get(current.packageDigest))?.manifest === null;
      await putVerifiedPackage(transaction, verified);
      await transaction.instances.put({
        ...current,
        packageDigest: input.computedPackageDigest,
        runtimeState: 'stopped',
        ...(incompatible ? { activationState: 'disabled' as const } : {}),
        lifecycleRevision: current.lifecycleRevision + 1,
        updatedAt: now,
      });
      return {
        pluginInstanceId: current.pluginInstanceId,
        packageDigest: input.computedPackageDigest,
      };
    });
  }

  async reinstallPackage(input: ReinstallPackageInput): Promise<InventoryMutationResult> {
    const now = this.now();
    const verified = await this.verify(input, now);
    const nextInstanceId = this.createInstanceId();
    return this.store.transaction(async (transaction) => {
      const current = await assertCurrentInstance(transaction, input.previousPluginInstanceId);
      if (current.pluginId !== verified.package.pluginId) {
        throw new PluginInventoryError(
          'PACKAGE_ID_MISMATCH',
          'reinstall package does not belong to the current instance',
        );
      }
      if (await transaction.instances.get(nextInstanceId)) {
        throw new PluginInventoryError('INSTANCE_ID_COLLISION', `plugin instance id ${nextInstanceId} already exists`);
      }
      await putVerifiedPackage(transaction, verified);
      await transaction.instances.put({
        ...current,
        lifecycleState: 'retired',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: current.lifecycleRevision + 1,
        retiredAt: now,
        updatedAt: now,
      });
      await transaction.instances.put(
        createInstance(nextInstanceId, current.pluginId, input.computedPackageDigest, now),
      );
      return { pluginInstanceId: nextInstanceId, packageDigest: input.computedPackageDigest };
    });
  }

  async recoverAfterRestart(): Promise<number> {
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      let changed = 0;
      for (const instance of await transaction.instances.list()) {
        const recovered = normalizePluginInstanceAfterRestart(instance, now);
        if (recovered === undefined) continue;
        await transaction.instances.put(recovered);
        changed += 1;
      }
      return changed;
    });
  }

  private async verify(input: PackageAdmissionCandidate, now: number): Promise<VerifiedPackageAdmission> {
    if (this.store.verifyAdmission && !this.options.contract) return this.store.verifyAdmission(input, now);
    return verifyPackageAdmission(input, now, this.options.contract);
  }

  protected now(): number {
    return this.options.now?.() ?? Date.now();
  }

  protected createInstanceId(): string {
    return this.options.createInstanceId?.() ?? `pi_${randomUUID()}`;
  }
}
