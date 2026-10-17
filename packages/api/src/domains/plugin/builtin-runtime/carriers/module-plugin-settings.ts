import { pathToFileURL } from 'node:url';
import { consumeOwnerOperationInvocation } from '../../carrier/plugin-owner-operation-context.js';
import { verifyPackageEntrypoint } from '../../external-runtime/package-entrypoint-authority.js';
import type { VerifiedPluginPackage } from '../../external-runtime/types.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { PluginPackageRecord } from '../../host-inventory/types.js';
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
  readonly dataDirectory?: string;
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
  readonly packageRecord: PluginPackageRecord;
  readonly effectiveGrants: readonly string[];
  readonly method: string;
  readonly params: unknown;
  readonly assertCurrent: () => Promise<void>;
}
export type PluginSettingsInvocationResult = { handled: false } | { handled: true; result: unknown };
export type PluginSettingsInvocation = (
  input: PluginSettingsInvocationInput,
) => Promise<PluginSettingsInvocationResult>;

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
  const declared =
    record.manifest.configuration?.some(
      (field) => field.kind === 'operation' && field.actions.some((action) => action.action.method === input.method),
    ) || record.manifest.test?.action.method === input.method;
  let settings: ModulePluginSettingsDefinition | undefined;
  let disposed = false;
  const current = async () => {
    if (disposed) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Settings request has ended');
    await input.assertCurrent();
  };
  try {
    if (!declared) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Settings action is not declared');
    for (const field of record.manifest.configuration ?? []) {
      if (field.kind !== 'operation' && field.key.startsWith(HOST_PROTOCOL_ENV_PREFIX))
        throw new ManifestConfigurationProjectionError({ reason: 'protocol_namespace', key: field.key });
    }
    await current();
    const { entrypoint } = await verifyPackageEntrypoint(record, options.located);
    await options.located.verifyIntegrity();
    const entry = (await import(pathToFileURL(entrypoint).href)).default;
    if (typeof entry?.create !== 'function')
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', 'Module must export create()');
    const definition = entry.create(structuredClone(record.manifest));
    if (typeof definition?.settings !== 'function') return { handled: false };
    const read = async (key: string, secret: boolean) => {
      await current();
      const field = record.manifest.configuration?.find(
        (item) => item.key === key && item.kind !== 'operation' && (item.kind === 'secret') === secret,
      );
      if (!field) return undefined;
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
    const dataDirectory = await preparePluginDataDirectory({
      parent: options.dataDirectoryParent,
      manifest: record.manifest,
      effectiveGrants: grants,
    });
    await current();
    settings = await definition.settings({
      pluginInstanceId: input.pluginInstanceId,
      ...(dataDirectory === undefined ? {} : { dataDirectory }),
      config: { get: (key: string) => read(key, false) },
      secrets: { get: (key: string) => read(key, true) },
      storage: scoped,
      log: options.log,
    });
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
