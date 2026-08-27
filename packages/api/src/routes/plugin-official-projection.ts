import type { PluginInstanceRecord, PluginInventorySnapshot } from '../domains/plugin/host-inventory/types.js';
import type { OfficialPluginCatalogEntry } from '../domains/plugin/official-catalog.js';
import { compareOfficialPluginVersions } from '../domains/plugin/official-catalog-provider.js';
import type { OfficialPluginMeetingIntakePort } from '../domains/plugin/official-plugin-meeting-intake-port.js';

function projectInstance(instance: PluginInstanceRecord | undefined, snapshot: PluginInventorySnapshot) {
  if (!instance) return null;
  const installedPackage = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
  return {
    pluginInstanceId: instance.pluginInstanceId,
    installedVersion: installedPackage?.version ?? null,
    packageDigest: instance.packageDigest,
    lifecycleState: instance.lifecycleState,
    configReadiness: instance.configReadiness,
    activationState: instance.activationState,
    runtimeState: instance.runtimeState,
    lifecycleRevision: instance.lifecycleRevision,
    installedAt: instance.installedAt,
    updatedAt: instance.updatedAt,
    ...(instance.lastRuntimeError === undefined ? {} : { lastRuntimeError: instance.lastRuntimeError }),
  };
}

export async function projectOfficialPlugin(
  entry: OfficialPluginCatalogEntry,
  snapshot: PluginInventorySnapshot,
  meetingIntake?: OfficialPluginMeetingIntakePort,
  instanceOverride?: PluginInstanceRecord,
) {
  const instance =
    instanceOverride ??
    snapshot.instances.find(
      (candidate) => candidate.pluginId === entry.pluginId && candidate.lifecycleState === 'installed',
    );
  const installedPackage = instance
    ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
    : undefined;
  const versionComparison = installedPackage
    ? compareOfficialPluginVersions(entry.version, installedPackage.version)
    : undefined;
  const intakeHealth = instance && meetingIntake ? await meetingIntake.project(entry, instance) : undefined;
  return {
    catalogId: entry.catalogId,
    packageName: entry.packageName,
    version: entry.version,
    availableVersion: entry.version,
    pluginId: entry.pluginId,
    packageDigest: entry.packageDigest,
    effectiveGrants: [...entry.effectiveGrants],
    ownerAuthAvailable: entry.ownerAuth !== undefined,
    updateAvailable: instance !== undefined && versionComparison !== undefined && versionComparison > 0,
    instance: projectInstance(instance, snapshot),
    ...(intakeHealth === undefined ? {} : { intakeHealth }),
  };
}
