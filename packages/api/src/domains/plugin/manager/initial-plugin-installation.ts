import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PLUGIN_HOST_ENTRIES } from '../host-inventory/plugin-host-layout.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { OfficialPluginPackageInstaller } from '../official-package-installer.js';
import type { DormantPluginRuntimeComposition, PluginManagerRuntimeComposition } from '../runtime-composition.js';
import { loadMachinePluginCatalog, OFFICIAL_PLUGIN_CATALOG_URL } from './machine-catalog-provider.js';
import type { OfficialPluginCatalogProvider, OfficialPluginCatalogSnapshot } from './official-catalog-provider.js';

export interface InitialPluginSelection {
  readonly schemaVersion: 1;
  readonly plugins: readonly { readonly pluginId: string; readonly enabled: boolean }[];
}
export interface InitialPluginInstallationOptions {
  readonly signal?: AbortSignal;
  readonly statePath: string;
  readonly inventory: PluginInventoryStore;
  readonly catalog: OfficialPluginCatalogProvider;
  readonly installer: Pick<OfficialPluginPackageInstaller, 'install' | 'installFromSnapshot'>;
  readonly loadSelection: () => Promise<unknown>;
  readonly reconcile?: (pluginId: string, instanceId: string) => Promise<void>;
  readonly activate: (
    pluginId: string,
    instanceId: string,
    expectedRevision: number,
    catalogSnapshot: OfficialPluginCatalogSnapshot,
  ) => Promise<void>;
  readonly onFailure: (pluginId: string, error: unknown) => void;
}

interface InitialPluginRecord {
  pluginId: string;
  catalogId: string;
  version: string;
  packageDigest: string;
  enabled: boolean;
  done: boolean;
  prepared?: boolean;
  instanceId?: string;
  revision?: number;
}
interface Journal {
  schemaVersion: 1;
  plugins: InitialPluginRecord[];
}
interface InitialPluginPlan {
  readonly journal: Journal;
  readonly catalogSnapshot?: OfficialPluginCatalogSnapshot;
}

/** Only read-only waits may be abandoned; writes keep their receipt before shutdown drains them. */
async function initialRead<T>(read: () => Promise<T>, signal?: AbortSignal) {
  if (!signal) return read();
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function parseInitialPluginSelection(value: unknown): InitialPluginSelection {
  const v = value as InitialPluginSelection | null;
  if (!v || v.schemaVersion !== 1 || !Array.isArray(v.plugins) || v.plugins.length > 64)
    throw new Error('Invalid initial plugin selection');
  const ids = new Set<string>();
  for (const item of v.plugins) {
    if (
      !item ||
      typeof item.pluginId !== 'string' ||
      !item.pluginId ||
      typeof item.enabled !== 'boolean' ||
      ids.has(item.pluginId)
    )
      throw new Error('Invalid or duplicate initial plugin selection');
    ids.add(item.pluginId);
  }
  return v;
}
async function loadJournal(statePath: string): Promise<Journal | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const journal = JSON.parse(raw) as Journal;
  parseInitialPluginSelection(journal);
  for (const p of journal.plugins) {
    if (
      typeof p.catalogId !== 'string' ||
      typeof p.version !== 'string' ||
      typeof p.packageDigest !== 'string' ||
      typeof p.done !== 'boolean'
    )
      throw new Error('Invalid initial plugin journal');
    if (p.instanceId !== undefined && (typeof p.instanceId !== 'string' || !Number.isInteger(p.revision)))
      throw new Error('Invalid initial plugin instance');
  }
  return journal;
}
async function saveJournal(statePath: string, journal: Journal): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(statePath), '.initial-plugin-installation.tmp');
  await writeFile(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}
async function begin(options: InitialPluginInstallationOptions): Promise<InitialPluginPlan> {
  options.signal?.throwIfAborted();
  const existing = await loadJournal(options.statePath);
  if (existing) return { journal: existing };
  const inventory = await options.inventory.snapshot();
  // Includes uninstall tombstones: existing users are never treated as a fresh Host.
  if (inventory.instances.length || inventory.packages.length) {
    options.signal?.throwIfAborted();
    const journal: Journal = { schemaVersion: 1, plugins: [] };
    await saveJournal(options.statePath, journal);
    return { journal };
  }
  const selection = parseInitialPluginSelection(await initialRead(options.loadSelection, options.signal));
  const catalog = await initialRead(() => options.catalog.snapshot(), options.signal);
  if (catalog.status !== 'fresh') throw new Error('Initial installation requires a current catalog');
  const plugins = selection.plugins.map((p) => {
    const e = catalog.entries.find((e) => e.pluginId === p.pluginId);
    if (!e) throw new Error(`Initial plugin is absent from catalog: ${p.pluginId}`);
    return {
      pluginId: p.pluginId,
      enabled: p.enabled,
      catalogId: e.catalogId,
      version: e.version,
      packageDigest: e.packageDigest,
      done: false,
    };
  });
  const journal: Journal = { schemaVersion: 1, plugins };
  options.signal?.throwIfAborted();
  await saveJournal(options.statePath, journal);
  return { journal, catalogSnapshot: catalog };
}
async function prepareInstance(
  options: InitialPluginInstallationOptions,
  journal: Journal,
  p: InitialPluginRecord,
  catalogSnapshot?: OfficialPluginCatalogSnapshot,
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!p.instanceId) {
    const history = (await options.inventory.snapshot()).instances.filter((i) => i.pluginId === p.pluginId);
    // A user install/uninstall (or admission interrupted before its receipt was saved) wins.
    if (history.length) {
      options.signal?.throwIfAborted();
      p.done = true;
      await saveJournal(options.statePath, journal);
      return;
    }
    options.signal?.throwIfAborted();
    const installed = await installInitialRelease(options, p, catalogSnapshot);
    const instance = (await options.inventory.snapshot()).instances.find(
      (i) => i.pluginInstanceId === installed.pluginInstanceId,
    );
    if (!instance) throw new Error('Initial installed instance disappeared');
    p.instanceId = instance.pluginInstanceId;
    p.revision = instance.lifecycleRevision;
    // Keep the receipt even if configuration fails; retry setup without a second admission.
    await saveJournal(options.statePath, journal);
  }
  const before = (await options.inventory.snapshot()).instances.find((i) => i.pluginInstanceId === p.instanceId);
  options.signal?.throwIfAborted();
  if (before?.lifecycleState !== 'installed' || before.lifecycleRevision !== p.revision) {
    p.done = true;
  } else {
    await options.reconcile?.(p.pluginId, p.instanceId);
    const after = (await options.inventory.snapshot()).instances.find((i) => i.pluginInstanceId === p.instanceId);
    // Reconciliation may change only readiness/revision. A concurrent owner change wins.
    if (
      !after ||
      after.lifecycleState !== before.lifecycleState ||
      after.activationState !== before.activationState ||
      after.runtimeState !== before.runtimeState ||
      after.packageDigest !== before.packageDigest ||
      after.lifecycleRevision !== before.lifecycleRevision + (after.configReadiness === before.configReadiness ? 0 : 1)
    ) {
      p.done = true;
    } else {
      p.revision = after.lifecycleRevision;
      p.prepared = true;
      p.done = !p.enabled;
    }
  }
  await saveJournal(options.statePath, journal);
}
async function installInitialRelease(
  options: InitialPluginInstallationOptions,
  p: InitialPluginRecord,
  catalogSnapshot?: OfficialPluginCatalogSnapshot,
) {
  const release = { version: p.version, packageDigest: p.packageDigest };
  return catalogSnapshot
    ? options.installer.installFromSnapshot(catalogSnapshot, p.catalogId, release)
    : options.installer.install(p.catalogId, release);
}
async function installPending(options: InitialPluginInstallationOptions, plan: InitialPluginPlan): Promise<void> {
  const { journal, catalogSnapshot } = plan;
  for (const p of journal.plugins) {
    if (p.done || p.prepared) continue;
    try {
      await prepareInstance(options, journal, p, catalogSnapshot);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.onFailure(p.pluginId, error);
    }
  }
}
async function operationCatalogSnapshot(
  options: InitialPluginInstallationOptions,
  plan: InitialPluginPlan,
): Promise<OfficialPluginCatalogSnapshot> {
  if (plan.catalogSnapshot) return plan.catalogSnapshot;
  try {
    return await initialRead(() => options.catalog.snapshot(), options.signal);
  } catch {
    options.signal?.throwIfAborted();
    return { entries: [], status: 'degraded', checkedAt: null, errorCode: 'CATALOG_FETCH_FAILED' };
  }
}
async function activateInstalled(options: InitialPluginInstallationOptions, plan: InitialPluginPlan): Promise<void> {
  options.signal?.throwIfAborted();
  const { journal } = plan;
  if (!journal.plugins.some((p) => !p.done && p.prepared && p.instanceId && p.revision !== undefined)) return;
  const catalogSnapshot = await operationCatalogSnapshot(options, plan);
  for (const p of journal.plugins) {
    if (p.done || !p.prepared || !p.instanceId || p.revision === undefined) continue;
    try {
      const instance = (await options.inventory.snapshot()).instances.find((i) => i.pluginInstanceId === p.instanceId);
      options.signal?.throwIfAborted();
      // Any user/lifecycle change wins over the initial default, including uninstall.
      if (instance?.lifecycleState === 'installed' && instance.lifecycleRevision === p.revision)
        await options.activate(p.pluginId, p.instanceId, p.revision, catalogSnapshot);
      p.done = true;
      await saveJournal(options.statePath, journal);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.onFailure(p.pluginId, error);
    }
  }
}
/** Called before recovery; activation is explicitly deferred until the Host has listened. */
export async function prepareInitialPluginInstallation(options: InitialPluginInstallationOptions) {
  const initialPlan = await begin(options);
  const plan =
    initialPlan.catalogSnapshot || !initialPlan.journal.plugins.some((p) => !p.done)
      ? initialPlan
      : { ...initialPlan, catalogSnapshot: await operationCatalogSnapshot(options, initialPlan) };
  await installPending(options, plan);
  return { activate: () => activateInstalled(options, plan) };
}

/** The same Manager installation/configuration/lifecycle used by explicit owner operations. */
export async function prepareHostInitialPlugins(options: {
  readonly hostListening: Promise<void>;
  readonly signal: AbortSignal;
  readonly runtime: DormantPluginRuntimeComposition;
  readonly managerRuntime: PluginManagerRuntimeComposition;
  readonly catalog: OfficialPluginCatalogProvider;
  readonly loadSelection?: () => Promise<unknown>;
  readonly onFailure: InitialPluginInstallationOptions['onFailure'];
}) {
  await initialRead(() => options.hostListening, options.signal);
  const { runtime, managerRuntime } = options;
  let managerCatalogSnapshot: ReturnType<typeof managerRuntime.officialCatalog.projectSnapshot> | undefined;
  return prepareInitialPluginInstallation({
    signal: options.signal,
    statePath: join(dirname(runtime.paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.initialInstallation),
    inventory: runtime.inventoryStore,
    catalog: options.catalog,
    installer: managerRuntime.officialInstaller,
    loadSelection:
      options.loadSelection ??
      (() => loadMachinePluginCatalog(new URL('initial-plugins.json', OFFICIAL_PLUGIN_CATALOG_URL).href)),
    reconcile: (pluginId, instanceId) => managerRuntime.configuration.reconcile(pluginId, instanceId),
    activate: async (pluginId, instanceId, expectedRevision, catalogSnapshot) => {
      const instance = (await runtime.inventoryStore.snapshot()).instances.find(
        (i) => i.pluginInstanceId === instanceId,
      );
      // Configuration requiring user input remains visible and disabled in Settings.
      if (instance?.configReadiness !== 'ready') return;
      managerCatalogSnapshot ??= managerRuntime.officialCatalog.projectSnapshot(catalogSnapshot);
      await managerRuntime.manager.setEnabledFromCatalogSnapshot(managerCatalogSnapshot, pluginId, {
        enabled: true,
        expectedRevision,
      });
    },
    onFailure: options.onFailure,
  });
}
