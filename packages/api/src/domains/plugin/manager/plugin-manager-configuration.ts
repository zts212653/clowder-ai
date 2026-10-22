import { type PluginManagerConfigField, type PluginManagerConfigureRequest } from '@cat-cafe/shared';
import type { inspectAcpBootstrapDirectory } from '../../cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';
import { type ExternalPluginLifecycleService, PluginLifecycleError } from '../external-plugin-lifecycle.js';
import type { VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import type { OperationState } from '../operations/operation-state-machine.js';
import { assertOperationCommit, type PluginOperationCommitFence } from '../operations/plugin-operation-fence.js';
import {
  readPluginConfig,
  readPluginConfigText,
  readPluginOperationState,
  restorePluginConfigText,
  writePluginConfig,
  writePluginOperationState,
} from '../plugin-config-store.js';
import {
  type AcpBootstrapConfigRecovery,
  prepareAcpBootstrapConfigRecovery,
} from './acp-bootstrap/acp-bootstrap-config-recovery.js';
import type { acpBootstrapDirectoryIdentity } from './acp-bootstrap/acp-bootstrap-directory-identity.js';
import { chromeSetupPolicy } from './chrome-setup/personal-chrome-setup-policy.js';
import { effectivePluginConfigurationValue } from './plugin-configuration-values.js';
import {
  assertConfigurationFence,
  configError,
  configureTransaction,
  manifestConfiguration,
  manifestConfigurationReady,
  manifestOperation,
  requireConfigurationTarget,
  validateUpdates,
  validateValue,
} from './plugin-configuration-write.js';
import {
  configFieldProjection,
  operationFieldProjection,
  projectConfigurationVariants,
} from './plugin-manager-field-projection.js';
import { type PluginManagerConfigurationPort, PluginManagerServiceError } from './plugin-manager-service.js';

export interface HostPluginConfigurationServiceOptions {
  readonly projectRoot: string;
  readonly inventory: PluginInventoryStore;
  readonly now?: () => number;
  readonly lifecycle?: Pick<ExternalPluginLifecycleService, 'runWithRuntimeSuspended'>;
  readonly packages?: VerifiedPluginPackageLocator;
  readonly inspectBootstrapRoot?: typeof inspectAcpBootstrapDirectory;
  readonly bootstrapDirectoryIdentity?: typeof acpBootstrapDirectoryIdentity;
}

export class HostPluginConfigurationService implements PluginManagerConfigurationPort {
  private readonly now: () => number;

  constructor(private readonly options: HostPluginConfigurationServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async fields(pluginId: string): Promise<readonly PluginManagerConfigField[] | undefined> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance) return undefined;
    const packageRecord = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    if (!packageRecord) {
      throw new PluginManagerServiceError('CONFIGURATION_UNAVAILABLE', 'Installed plugin package is unavailable');
    }
    if (packageRecord.manifest === null) return [];
    const stored = readPluginConfig(this.options.projectRoot, pluginId);
    const fields = manifestConfiguration(packageRecord);
    const configurationVariants = projectConfigurationVariants(packageRecord.manifest);
    const hostSetup = chromeSetupPolicy(packageRecord);
    return [
      ...(hostSetup ? [operationFieldProjection(hostSetup, undefined, [], {})] : []),
      ...(packageRecord.manifest.configuration ?? []).map((field) =>
        field.kind === 'operation'
          ? operationFieldProjection(
              field,
              readPluginOperationState(this.options.projectRoot, pluginId, field.key),
              fields,
              stored,
            )
          : configFieldProjection(field, fields, stored, configurationVariants),
      ),
    ];
  }

  async readActionInput(pluginId: string): Promise<Readonly<Record<string, unknown>>> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance) return {};
    const packageRecord = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    if (!packageRecord) {
      throw new PluginManagerServiceError('CONFIGURATION_UNAVAILABLE', 'Installed plugin package is unavailable');
    }
    const stored = readPluginConfig(this.options.projectRoot, pluginId);
    const values: Record<string, unknown> = {};
    for (const field of manifestConfiguration(packageRecord)) {
      if (field.kind === 'secret') continue;
      const value = effectivePluginConfigurationValue(field, stored[field.key]);
      if (value !== undefined) values[field.key] = value;
    }
    return values;
  }

  async readOperationState(pluginId: string, operationKey: string): Promise<OperationState | undefined> {
    return readPluginOperationState(this.options.projectRoot, pluginId, operationKey);
  }

  async writeOperationState(
    pluginId: string,
    operationKey: string,
    state: OperationState,
    fence?: PluginOperationCommitFence,
  ): Promise<void> {
    await this.options.inventory.transaction((transaction) => {
      if (fence) assertOperationCommit(fence, transaction, pluginId);
      writePluginOperationState(this.options.projectRoot, pluginId, operationKey, state);
    });
  }

  async clearOperationState(pluginId: string, operationKey: string): Promise<void> {
    await this.options.inventory.transaction(() => {
      writePluginOperationState(this.options.projectRoot, pluginId, operationKey, undefined);
    });
  }

  async configureOperationTargets(
    pluginId: string,
    pluginInstanceId: string,
    operationKey: string,
    values: Readonly<Record<string, string>>,
    fence?: PluginOperationCommitFence,
  ): Promise<readonly string[]> {
    return this.options.inventory.transaction((transaction) => {
      if (fence) assertOperationCommit(fence, transaction, pluginId);
      const instance = transaction.instances.getCurrent(pluginId);
      const record = instance && transaction.packages.get(instance.packageDigest);
      if (
        !instance ||
        instance.pluginInstanceId !== pluginInstanceId ||
        instance.lifecycleState !== 'installed' ||
        !record
      )
        throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin instance changed');
      return this.writeOperationTargets(pluginId, operationKey, values, record);
    });
  }

  private writeOperationTargets(
    pluginId: string,
    operationKey: string,
    values: Readonly<Record<string, string>>,
    packageRecord: PluginPackageRecord,
  ): readonly string[] {
    const operation = manifestOperation(packageRecord, operationKey);
    if (!operation) throw configError(`Operation ${operationKey} is not declared by this plugin`);
    const targetKeys = new Set(operation.target ?? []);
    const fields = new Map(manifestConfiguration(packageRecord).map((field) => [field.key, field]));
    const updates: { name: string; value: string }[] = [];
    for (const [key, value] of Object.entries(values)) {
      const field = fields.get(key);
      if (!targetKeys.has(key) || !field) throw configError(`Operation target ${key} is not declared by this plugin`);
      validateValue(field, value);
      updates.push({ name: key, value });
    }
    return writePluginConfig(this.options.projectRoot, pluginId, updates).changedKeys;
  }

  async reconcile(pluginId: string, pluginInstanceId: string): Promise<void> {
    await this.options.inventory.transaction((transaction) => {
      const current = requireConfigurationTarget(transaction, pluginId, pluginInstanceId);
      if (
        current.packageRecord.manifest === null ||
        current.instance.runtimeState !== 'stopped' ||
        ['enabling', 'disabling'].includes(current.instance.activationState)
      )
        return;
      const stored = readPluginConfig(this.options.projectRoot, pluginId);
      const configReadiness = manifestConfigurationReady(current.packageRecord, stored) ? 'ready' : 'incomplete';
      if (configReadiness === current.instance.configReadiness) return;
      transaction.instances.put({
        ...current.instance,
        configReadiness,
        lifecycleRevision: current.instance.lifecycleRevision + 1,
        updatedAt: this.now(),
      });
    });
  }

  async completeOperation(pluginId: string, pluginInstanceId: string, expectedRevision: number): Promise<void> {
    await this.configureInternal(pluginId, pluginInstanceId, { expectedRevision, updates: [] }, true);
  }

  async configure(pluginId: string, pluginInstanceId: string, request: PluginManagerConfigureRequest): Promise<void> {
    return this.configureInternal(pluginId, pluginInstanceId, request, false);
  }

  async configureBootstrapRoot(
    pluginId: string,
    pluginInstanceId: string,
    request: PluginManagerConfigureRequest,
  ): Promise<void> {
    return this.configureInternal(pluginId, pluginInstanceId, request, false, true);
  }

  private async configureInternal(
    pluginId: string,
    pluginInstanceId: string,
    request: PluginManagerConfigureRequest,
    allowEmpty: boolean,
    bootstrapRootRecovery = false,
  ): Promise<void> {
    let recovery: AcpBootstrapConfigRecovery | undefined;
    let persisted = false;
    let compensated = false;
    const prepareRecovery = async () => {
      if (bootstrapRootRecovery)
        recovery = await prepareAcpBootstrapConfigRecovery({ ...this.options, pluginId, pluginInstanceId, request });
    };
    const persist = async (expectedRevision: number, liveRefresh = false) => {
      await recovery?.verify();
      let previous: string | undefined;
      let written: string | undefined;
      await this.options.inventory.transaction(
        (transaction) => {
          previous = readPluginConfigText(this.options.projectRoot, pluginId);
          configureTransaction({
            transaction,
            projectRoot: this.options.projectRoot,
            pluginId,
            pluginInstanceId,
            request: { ...request, expectedRevision },
            allowEmpty,
            liveRefresh,
            now: this.now(),
            afterConfigWrite: () => {
              persisted = true;
              written = readPluginConfigText(this.options.projectRoot, pluginId);
            },
            ...(recovery ? { beforeWrite: (tx) => recovery?.assertCurrent(tx) } : {}),
          });
        },
        bootstrapRootRecovery
          ? {
              onCommitFailure: () => {
                if (written === undefined) return;
                restorePluginConfigText(this.options.projectRoot, pluginId, written, previous);
                persisted = false;
                compensated = true;
              },
            }
          : undefined,
      );
    };
    try {
      if (!this.options.lifecycle) {
        await prepareRecovery();
        return await persist(request.expectedRevision);
      }
      await this.options.lifecycle.runWithRuntimeSuspended({
        instanceId: pluginInstanceId,
        expectedRevision: request.expectedRevision,
        stopReason: 'configuration_update',
        resumeFailureCode: 'CONFIGURATION_RESUME_FAILED',
        preflight: async () => {
          await this.options.inventory.transaction((transaction) => {
            const current = requireConfigurationTarget(transaction, pluginId, pluginInstanceId);
            assertConfigurationFence(current.instance, request.expectedRevision);
            const fields = manifestConfiguration(current.packageRecord);
            if (fields.length === 0) {
              throw new PluginManagerServiceError('CONFIGURATION_UNAVAILABLE', 'Plugin does not declare configuration');
            }
            validateUpdates(fields, request.updates, allowEmpty);
          });
          await prepareRecovery();
        },
        operation: async (stopped) => {
          await persist(stopped.lifecycleRevision, stopped.runtimeState !== 'stopped');
          persisted = true;
        },
      });
    } catch (error) {
      if (compensated && error instanceof PluginLifecycleError && error.code === 'CONFIGURATION_RESUME_FAILED')
        throw new PluginManagerServiceError(
          'RUNTIME_START_FAILED',
          'Previous configuration restored, but the plugin runtime could not be restored; refresh plugin state and retry after fixing runtime startup',
        );
      if (compensated)
        throw new PluginManagerServiceError(
          'CONFIGURATION_UNAVAILABLE',
          'Configuration was not saved; previous text restored after inventory commit failure. Restore inventory storage and retry.',
        );
      if (persisted)
        throw new PluginManagerServiceError(
          'RUNTIME_START_FAILED',
          'Configuration saved, but the plugin inventory or runtime update did not complete; restore inventory and audit storage, refresh the saved configuration and plugin state, then retry',
        );
      if (!(error instanceof PluginLifecycleError)) throw error;
      if (error.code === 'STALE_REVISION' || error.code === 'STALE_INSTANCE') {
        throw new PluginManagerServiceError('STALE_REVISION', error.message);
      }
      if (error.code === 'CONFIGURATION_RESUME_FAILED') {
        throw new PluginManagerServiceError(
          'RUNTIME_START_FAILED',
          persisted
            ? 'Configuration saved, but the plugin could not restart'
            : 'Configuration failed, and the previous runtime could not be restored',
        );
      }
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', error.message);
    } finally {
      await recovery?.release();
    }
  }
}
