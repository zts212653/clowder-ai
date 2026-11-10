import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  createModuleSettingsHost,
  type ModulePluginSettingsHost,
} from '../builtin-runtime/carriers/module-plugin-settings.js';
import { currentOwnerOperationRequest } from '../carrier/plugin-owner-operation-context.js';
import { resolvePackageFile } from '../declared/declared-resource-paths.js';
import type { VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { ExecutablePluginPackageRecord, PluginInstanceRecord } from '../host-inventory/types.js';
import { pluginDataDirectoryParent } from '../host-surface/plugin-data-directory.js';
import type { PluginPrivateStoragePort } from '../host-surface/plugin-private-storage.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';

const DOT_PLUGIN_ID = 'official.chatgpt-dot';
const LEGACY_IMPORT_PATH = 'dist/migration.js';

export type PluginMigrationInvocationErrorCode =
  | 'OWNER_AUTHORITY_REQUIRED'
  | 'MIGRATION_BINDING_CHANGED'
  | 'MIGRATION_IMPORTER_UNAVAILABLE';

export class PluginMigrationInvocationError extends Error {
  constructor(
    readonly code: PluginMigrationInvocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginMigrationInvocationError';
  }
}

export interface PluginMigrationInvocationInput {
  readonly pluginId: string;
  readonly expectedPluginInstanceId: string;
  readonly expectedPackageDigest: string;
  readonly payload: unknown;
}

interface LegacyImporterModule {
  importLegacyBatch(
    host: ModulePluginSettingsHost,
    input: unknown,
    context: {
      readonly kind: 'owner-operation';
      readonly userId: string;
      readonly pluginInstanceId: string;
      readonly operationKey: 'legacy-import';
      readonly actionId: 'import';
      readonly requestId: string;
      readonly signal: AbortSignal;
      assertCurrent(): Promise<void>;
    },
  ): Promise<unknown>;
}

/**
 * Isolated adapter for the retired built-in Dot data layout. This is not a plugin
 * platform capability: no manifest method, settings action or public route selects it.
 */
export class PluginMigrationInvoker {
  constructor(
    private readonly options: {
      readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
      readonly packages: VerifiedPluginPackageLocator;
      readonly configuration: PluginRuntimeConfigurationPort;
      readonly projectRoot: string;
      readonly storage?: PluginPrivateStoragePort;
      readonly log: ModulePluginSettingsHost['log'];
    },
  ) {}

  async invoke(input: PluginMigrationInvocationInput): Promise<unknown> {
    const owner = currentOwnerOperationRequest();
    if (
      input.pluginId !== DOT_PLUGIN_ID ||
      !owner ||
      owner.pluginId !== DOT_PLUGIN_ID ||
      owner.operationKey !== 'legacy-import' ||
      owner.actionId !== 'import'
    ) {
      throw new PluginMigrationInvocationError(
        'OWNER_AUTHORITY_REQUIRED',
        'Legacy Dot import requires a local owner request',
      );
    }
    const binding = await this.resolveBinding(input);
    const assertCurrent = () => this.assertCurrent(input, binding);
    const located = await this.options.packages.resolveInstalledPackage(binding.packageRecord.packageDigest);
    try {
      if (!isDeepStrictEqual(located.manifest, binding.packageRecord.manifest)) {
        throw new PluginMigrationInvocationError(
          'MIGRATION_BINDING_CHANGED',
          'Located package manifest differs from the installed legacy-import binding',
        );
      }
      await assertCurrent();
      await located.verifyIntegrity();
      const importerPath = await resolvePackageFile(located.rootDir, LEGACY_IMPORT_PATH, 'legacy Dot importer');
      const imported = (await import(pathToFileURL(importerPath).href)) as Partial<LegacyImporterModule>;
      if (typeof imported.importLegacyBatch !== 'function') {
        throw new PluginMigrationInvocationError(
          'MIGRATION_IMPORTER_UNAVAILABLE',
          'Installed Dot package has no isolated legacy importer',
        );
      }
      let active = true;
      const current = async () => {
        if (!active || owner.signal.aborted) {
          throw new PluginMigrationInvocationError('MIGRATION_BINDING_CHANGED', 'Legacy Dot import request expired');
        }
        owner.assertCurrent();
        await assertCurrent();
      };
      const host = await createModuleSettingsHost(
        {
          pluginInstanceId: binding.instance.pluginInstanceId,
          packageRecord: binding.packageRecord,
        },
        {
          configuration: this.options.configuration,
          ...(this.options.storage ? { storage: this.options.storage } : {}),
          dataDirectoryParent: pluginDataDirectoryParent(this.options.projectRoot),
          log: this.options.log,
        },
        current,
      );
      const context = Object.freeze({
        kind: 'owner-operation' as const,
        userId: owner.userId,
        pluginInstanceId: binding.instance.pluginInstanceId,
        operationKey: 'legacy-import' as const,
        actionId: 'import' as const,
        requestId: owner.requestId,
        signal: owner.signal,
        assertCurrent: current,
      });
      try {
        await current();
        const result = await imported.importLegacyBatch(host, structuredClone(input.payload), context);
        await current();
        return result;
      } finally {
        active = false;
      }
    } finally {
      await located.release();
    }
  }

  private async resolveBinding(input: PluginMigrationInvocationInput): Promise<MigrationBinding> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) =>
        candidate.pluginId === DOT_PLUGIN_ID &&
        candidate.pluginInstanceId === input.expectedPluginInstanceId &&
        candidate.lifecycleState === 'installed',
    );
    const packageRecord = snapshot.packages.find(
      (candidate): candidate is ExecutablePluginPackageRecord =>
        candidate.packageDigest === instance?.packageDigest && candidate.manifest !== null,
    );
    if (
      !instance ||
      instance.packageDigest !== input.expectedPackageDigest ||
      !packageRecord ||
      packageRecord.pluginId !== DOT_PLUGIN_ID ||
      packageRecord.manifest.runtime?.transport !== 'builtin' ||
      typeof packageRecord.manifest.runtime.entrypoint !== 'string'
    ) {
      throw new PluginMigrationInvocationError(
        'MIGRATION_BINDING_CHANGED',
        'Installed Dot legacy-import binding changed',
      );
    }
    return {
      instance,
      packageRecord,
    };
  }

  private async assertCurrent(input: PluginMigrationInvocationInput, binding: MigrationBinding): Promise<void> {
    const current = await this.resolveBinding(input);
    if (
      current.instance.lifecycleRevision !== binding.instance.lifecycleRevision ||
      current.packageRecord.packageDigest !== binding.packageRecord.packageDigest
    ) {
      throw new PluginMigrationInvocationError(
        'MIGRATION_BINDING_CHANGED',
        'Installed Dot legacy-import binding changed',
      );
    }
  }
}

interface MigrationBinding {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: ExecutablePluginPackageRecord;
}
