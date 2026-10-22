import { pathToFileURL } from 'node:url';
import { consumeOwnerOperationInvocation } from '../../carrier/plugin-owner-operation-context.js';
import { declaresConfigurationVariants, resolveVariant } from '../../configuration-variant-consumption.js';
import { verifyPackageEntrypoint } from '../../external-runtime/package-entrypoint-authority.js';
import type { VerifiedPluginPackage } from '../../external-runtime/types.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { ExecutablePluginPackageRecord } from '../../host-inventory/types.js';
import { preparePluginDataDirectory } from '../../host-surface/plugin-data-directory.js';
import {
  createPluginStorageHost,
  type PluginPrivateStoragePort,
  type PluginStorageHost,
} from '../../host-surface/plugin-private-storage.js';
import { effectivePluginConfigurationValue } from '../../manager/plugin-configuration-values.js';
import {
  HOST_PROTOCOL_ENV_PREFIX,
  ManifestConfigurationProjectionError,
  type PluginRuntimeConfigurationPort,
} from '../../manifest-configuration-projection.js';
import { snapshotModuleAuthority } from './module-authority-snapshot.js';

/** The original loaded-plugin settings surface; it does not start subscriptions or an adapter. */
export interface ModulePluginSettingsHost {
  readonly pluginInstanceId: string;
  readonly dataPath: string;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}
export interface ModulePluginSettingsDefinition {
  readonly actions: Readonly<Record<string, unknown>>;
  dispose?(): void | Promise<void>;
}
export interface PluginSettingsInvocationInput {
  readonly pluginInstanceId: string;
  readonly packageRecord: ExecutablePluginPackageRecord;
  readonly effectiveGrants: readonly string[];
  readonly method: string;
  readonly params: unknown;
  readonly assertCurrent: () => Promise<void>;
}
export type PluginSettingsInvocationResult = { handled: false } | { handled: true; result: unknown };
export type PluginSettingsInvocation = (
  input: PluginSettingsInvocationInput,
) => Promise<PluginSettingsInvocationResult>;

/** Shared declaration boundary, including probes that need no package materialization. */
export function assertModuleSettingsDeclaration(record: ExecutablePluginPackageRecord, method: string): void {
  const declared =
    record.manifest.configuration?.some(
      (field) => field.kind === 'operation' && field.actions.some((action) => action.action.method === method),
    ) || record.manifest.test?.action.method === method;
  if (!declared) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Settings action is not declared');
  for (const field of record.manifest.configuration ?? []) {
    if (field.kind !== 'operation' && field.key.startsWith(HOST_PROTOCOL_ENV_PREFIX))
      throw new ManifestConfigurationProjectionError({ reason: 'protocol_namespace', key: field.key });
  }
}

export async function invokeModuleSettings(
  input: PluginSettingsInvocationInput,
  options: {
    located: VerifiedPluginPackage;
    configuration: PluginRuntimeConfigurationPort;
    storage?: PluginPrivateStoragePort;
    dataDirectoryParent?: string;
    log: ModulePluginSettingsHost['log'];
  },
): Promise<PluginSettingsInvocationResult> {
  const record = snapshotModuleAuthority(input.packageRecord);
  const grants = snapshotModuleAuthority(input.effectiveGrants);
  let settings: ModulePluginSettingsDefinition | undefined;
  let disposed = false;
  const current = async () => {
    if (disposed) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Settings request has ended');
    await input.assertCurrent();
  };
  try {
    assertModuleSettingsDeclaration(record, input.method);
    await current();
    const { entrypoint } = await verifyPackageEntrypoint(record, options.located);
    await options.located.verifyIntegrity();
    const entry = (await import(pathToFileURL(entrypoint).href)).default;
    if (typeof entry?.create !== 'function')
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'Module must export create()');
    const definition = entry.create(structuredClone(record.manifest));
    if (typeof definition?.settings !== 'function') return { handled: false };
    const host = await createModuleSettingsHost(input, options, current);
    settings = await definition.settings(host);
    await current();
    const actions = settings?.actions;
    const action = actions && Object.hasOwn(actions, input.method) ? actions[input.method] : undefined;
    if (typeof action !== 'function') return { handled: false };
    const result = await consumeOwnerOperationInvocation(
      input.pluginInstanceId,
      input.method,
      undefined,
      // Settings has no runtime activation. The issued authority checks the
      // installed instance/grant/request fence, also used by the later Host commit.
      () => {},
      async (owner) => action.call(actions, structuredClone(input.params), undefined, owner),
    );
    await current();
    return { handled: true, result };
  } finally {
    disposed = true;
    try {
      await settings?.dispose?.();
    } finally {
      await options.located.release();
    }
  }
}

/** Shared dormant client for settings and uninstall; never activates plugin business resources. */
export async function createModuleSettingsHost(
  input: Pick<PluginSettingsInvocationInput, 'pluginInstanceId' | 'packageRecord' | 'effectiveGrants'>,
  options: {
    configuration: PluginRuntimeConfigurationPort;
    storage?: PluginPrivateStoragePort;
    dataDirectoryParent?: string;
    log: ModulePluginSettingsHost['log'];
    /**
     * `runtime` (the carrier start() path) fail-closes the settings surface on
     * variant declarations: the variant is resolved once, lazily, and an
     * unselected/invalid declaration makes every read refuse, while fields of
     * inactive branches return `undefined` without touching the store.
     * `management` (settings actions, uninstall, probes) keeps the legacy
     * pass-through so owners can always reach every declared field.
     */
    variantMode?: 'runtime' | 'management';
  },
  current: () => Promise<void>,
): Promise<ModulePluginSettingsHost> {
  const record = snapshotModuleAuthority(input.packageRecord);
  const grants = snapshotModuleAuthority(input.effectiveGrants);
  const variantRuntime = options.variantMode === 'runtime' && declaresConfigurationVariants(record.manifest);
  let variantResolutionPromise: Promise<ReturnType<typeof resolveVariant>> | undefined;
  const variantResolution = () => {
    variantResolutionPromise ??= (async () => {
      const variants = record.manifest.configurationVariants;
      if (!variants) return { status: 'unselected' as const };
      const discriminatorField = record.manifest.configuration?.find(
        (item) => item.key === variants.discriminator && item.kind !== 'operation',
      );
      const capability = discriminatorField?.kind === 'secret' ? 'secret.read' : 'plugin.config.read';
      let stored: unknown;
      // The grant discipline the projection uses: no grant, no store read —
      // the contract then falls back to the discriminator field's default.
      if (discriminatorField && grants.includes(capability)) {
        stored =
          discriminatorField.kind === 'secret'
            ? await options.configuration.readSecret(input.pluginInstanceId, variants.discriminator)
            : await options.configuration.readConfig(input.pluginInstanceId, variants.discriminator);
      }
      return resolveVariant(record.manifest, stored === undefined ? {} : { [variants.discriminator]: stored });
    })();
    return variantResolutionPromise;
  };
  const read = async (key: string, secret: boolean) => {
    await current();
    const field = record.manifest.configuration?.find(
      (item) => item.key === key && item.kind !== 'operation' && (item.kind === 'secret') === secret,
    );
    if (!field) return undefined;
    if (variantRuntime) {
      const resolution = await variantResolution();
      if (resolution.status !== 'selected')
        throw new ExternalPluginRuntimeError(
          'DELIVERY_REJECTED',
          `Configuration variant is ${resolution.status}; runtime reads are refused until a branch is selected`,
        );
      const variants = record.manifest.configurationVariants;
      const branch = variants?.branches.find((item) => item.id === resolution.branchId);
      const claimedByBranch = variants?.branches.some((item) => item.fields.includes(key)) ?? false;
      // Inactive-branch fields are never delivered to the runtime: no store
      // read, no error, just absence — mirroring the startup projection.
      if (claimedByBranch && !(branch?.fields.includes(key) ?? false)) return undefined;
    }
    const capability = secret ? 'secret.read' : 'plugin.config.read';
    if (!grants.includes(capability))
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `Settings lacks ${capability}`);
    const value = secret
      ? await options.configuration.readSecret(input.pluginInstanceId, key)
      : await options.configuration.readConfig(input.pluginInstanceId, key);
    await current();
    const effective = effectivePluginConfigurationValue(field, value);
    if (field.kind === 'boolean' && effective !== undefined) return effective === 'true';
    if (field.kind === 'number' && effective !== undefined) return Number(effective);
    return effective;
  };
  const storage = createPluginStorageHost({
    pluginId: record.pluginId,
    effectiveGrants: grants,
    ...(options.storage ? { storage: options.storage } : {}),
  });
  const scoped = Object.fromEntries(
    Object.entries(storage).map(([key, method]) => [
      key,
      async (...args: unknown[]) => {
        await current();
        const result = await (method as (...args: unknown[]) => Promise<unknown>)(...args);
        await current();
        return result;
      },
    ]),
  ) as unknown as PluginStorageHost;
  await current();
  const dataPath = await preparePluginDataDirectory({
    parent: options.dataDirectoryParent,
    manifest: record.manifest,
    effectiveGrants: grants,
  });
  await current();
  return {
    pluginInstanceId: input.pluginInstanceId,
    dataPath,
    config: { get: (key: string) => read(key, false) },
    secrets: {
      get: async (key: string) => {
        const value = await read(key, true);
        return typeof value === 'string' ? value : undefined;
      },
    },
    storage: scoped,
    log: options.log,
  };
}
