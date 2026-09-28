import type {
  PluginDescription,
  PluginIconSpec,
  PluginManagerActions,
  PluginManagerArtifactState,
  PluginManagerAuthState,
  PluginManagerCapability,
  PluginManagerConfigState,
  PluginManagerContribution,
  PluginManagerIntentState,
  PluginManagerListItem,
  PluginManagerLiveState,
  PluginManagerPackageSource,
} from '@cat-cafe/shared';
import type { Capability, PluginManifest } from '@clowder-ai/plugin-contract';
import type {
  PluginInstanceRecord,
  PluginInventorySnapshot,
  PluginPackageRecord,
  PluginRuntimeErrorRecord,
} from './host-inventory/types.js';

/** Catalog-owned metadata required to render an available plugin before installation. */
export interface PluginManagerCatalogCandidate {
  readonly catalogId: string;
  readonly pluginId: string;
  readonly packageName: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly displayName: string;
  readonly description?: PluginDescription;
  readonly icon?: PluginIconSpec;
  readonly iconBg?: string;
  readonly publisher?: string;
  readonly ownerAuthRequired: boolean;
  readonly capabilities: readonly Omit<PluginManagerCapability, 'active'>[];
  readonly contributions?: readonly PluginManagerContribution[];
}

export interface PluginManagerProjectionOverrides {
  /** Typed auth contribution. Runtime health must never be used as an auth proxy. */
  readonly authState?: PluginManagerAuthState;
  /** Config service projection; Host inventory currently represents ready/incomplete only. */
  readonly configState?: PluginManagerConfigState;
  /** Desired intent reader override for lifecycle error states where activationState is ambiguous. */
  readonly intentState?: PluginManagerIntentState;
  /** Capability registry truth. A grant or visible label alone does not make a capability active. */
  readonly activeCapabilityIds?: readonly string[];
}

export interface DerivePluginManagerActionsInput {
  readonly artifact: PluginManagerArtifactState;
  readonly config: PluginManagerConfigState;
  readonly auth: PluginManagerAuthState;
  readonly intent: PluginManagerIntentState;
  readonly activationTransition: boolean;
}

function capabilityKind(capability: Capability): PluginManagerCapability['kind'] {
  if (capability.startsWith('events.')) return 'events';
  if (capability.startsWith('messaging.') || capability === 'onMessage') return 'messaging';
  if (capability.startsWith('schedule.')) return 'schedule';
  if (capability.startsWith('windows.') || capability.startsWith('whisper.')) return 'identity';
  return 'service';
}

export function pluginManagerCapabilitiesFromManifest(
  manifest: PluginManifest,
): readonly Omit<PluginManagerCapability, 'active'>[] {
  const capabilities = new Map<Capability, Omit<PluginManagerCapability, 'active'>>();
  for (const feature of manifest.features) {
    for (const capability of feature.capabilities) {
      if (!capabilities.has(capability)) {
        capabilities.set(capability, {
          id: capability,
          kind: capabilityKind(capability),
          name: feature.name,
        });
      }
    }
  }
  return [...capabilities.values()];
}

type ManifestContribution = NonNullable<PluginManifest['contributions']>[number];

function contributionKind(contribution: ManifestContribution): PluginManagerContribution['kind'] {
  switch (contribution.type) {
    case 'tool':
      return 'direct-tool';
    case 'message-subscription':
      return 'messaging';
    default:
      return contribution.type;
  }
}

function contributionName(contribution: ManifestContribution): string {
  switch (contribution.type) {
    case 'identity':
      return contribution.displayName;
    case 'tool':
      return contribution.name;
    case 'ui':
      return contribution.label;
    default:
      return contribution.id;
  }
}

/** Projects verified package contributions without relabeling Host permission grants as user-facing tools. */
export function pluginManagerContributionsFromManifest(manifest: PluginManifest): readonly PluginManagerContribution[] {
  return (manifest.contributions ?? []).map((contribution) => ({
    id: contribution.id,
    kind: contributionKind(contribution),
    name: contributionName(contribution),
    ...(contribution.type === 'tool' && contribution.description !== undefined
      ? { description: contribution.description }
      : {}),
  }));
}

function blockedArtifactReason(artifact: PluginManagerArtifactState): string {
  switch (artifact) {
    case 'quarantined':
      return 'package-quarantined';
    case 'staged':
      return 'package-staged';
    case 'verified':
      return 'package-not-installed';
    case 'absent':
      return 'package-absent';
    case 'installed':
      return 'package-installed';
  }
}

export function derivePluginManagerActions(input: DerivePluginManagerActionsInput): PluginManagerActions {
  if (input.artifact === 'absent') {
    return { install: true, setEnabled: false, uninstall: false, blockingReasons: [] };
  }
  if (input.artifact !== 'installed') {
    return {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: [blockedArtifactReason(input.artifact)],
    };
  }
  if (input.activationTransition) {
    return {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['activation-transition'],
    };
  }

  // Disabling is a safety action and remains available even when config/auth later degrade.
  if (input.intent === 'enabled') {
    return { install: false, setEnabled: true, uninstall: true, blockingReasons: [] };
  }

  const blockingReasons: string[] = [];
  if (input.config !== 'ready') blockingReasons.push(`config-${input.config}`);
  if (input.auth !== 'not-required' && input.auth !== 'connected') {
    blockingReasons.push(`auth-${input.auth}`);
  }
  return {
    install: false,
    setEnabled: blockingReasons.length === 0,
    uninstall: true,
    blockingReasons,
  };
}

function liveState(
  state: 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed',
): PluginManagerLiveState {
  return state === 'healthy' ? 'running' : state;
}

function intentState(
  activationState: 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error',
  override: PluginManagerIntentState | undefined,
): PluginManagerIntentState {
  if (override) return override;
  if (activationState === 'enabling' || activationState === 'enabled') return 'enabled';
  return 'disabled';
}

function diagnostic(error: PluginRuntimeErrorRecord | undefined, revision: number) {
  if (!error) return undefined;
  return {
    code: error.code,
    message: `Plugin runtime reported ${error.code}.`,
    occurredAt: error.occurredAt,
    revision,
  };
}

function candidatePackage(
  candidate: PluginManagerCatalogCandidate,
  snapshot: PluginInventorySnapshot,
  instance: PluginInstanceRecord | undefined,
): PluginPackageRecord | undefined {
  if (instance) return snapshot.packages.find((item) => item.packageDigest === instance.packageDigest);
  return snapshot.packages.find(
    (item) => item.packageDigest === candidate.packageDigest && item.packageState === 'quarantined',
  );
}

function candidateSource(
  candidate: PluginManagerCatalogCandidate,
  packageRecord: PluginPackageRecord | undefined,
): PluginManagerPackageSource {
  const provenance = packageRecord?.provenance;
  if (provenance?.kind === 'local-directory' || provenance?.kind === 'local-archive') {
    return {
      kind: provenance.kind,
      packageName: provenance.packageName ?? null,
      trust: 'local-trusted',
    };
  }
  return {
    kind: 'catalog',
    catalogId: candidate.catalogId,
    packageName: candidate.packageName,
    trust: 'official',
  };
}

export function pluginManagerPackageIconUrl(pluginId: string): string {
  return `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/icon`;
}

function candidatePresentation(candidate: PluginManagerCatalogCandidate, installedManifest?: PluginManifest) {
  const description = installedManifest ? installedManifest.description : candidate.description;
  const declaredIcon = installedManifest ? installedManifest.icon : candidate.icon;
  const icon =
    declaredIcon !== undefined && typeof declaredIcon !== 'string'
      ? { ...declaredIcon, src: pluginManagerPackageIconUrl(candidate.pluginId) }
      : declaredIcon;
  return {
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    ...(candidate.iconBg === undefined ? {} : { iconBg: candidate.iconBg }),
    ...(candidate.publisher === undefined ? {} : { publisher: candidate.publisher }),
  };
}

function projectionState(
  candidate: PluginManagerCatalogCandidate,
  instance: PluginInstanceRecord | undefined,
  packageRecord: PluginPackageRecord | undefined,
  overrides: PluginManagerProjectionOverrides,
) {
  const artifact: PluginManagerArtifactState = instance ? 'installed' : (packageRecord?.packageState ?? 'absent');
  const config: PluginManagerConfigState =
    overrides.configState ?? (instance?.configReadiness === 'ready' ? 'ready' : 'incomplete');
  const auth: PluginManagerAuthState =
    overrides.authState ?? (candidate.ownerAuthRequired ? 'disconnected' : 'not-required');
  const intent = instance ? intentState(instance.activationState, overrides.intentState) : 'disabled';
  const live = instance ? liveState(instance.runtimeState) : 'stopped';
  const activationTransition = instance?.activationState === 'enabling' || instance?.activationState === 'disabling';
  return { artifact, config, auth, intent, live, activationTransition };
}

function projectCapabilities(
  capabilities: readonly Omit<PluginManagerCapability, 'active'>[],
  effectiveGrants: readonly string[],
  activeCapabilityIds: readonly string[],
) {
  const granted = new Set(effectiveGrants);
  const active = new Set(activeCapabilityIds);
  return capabilities.map((capability) => ({
    ...capability,
    active: active.has(capability.id) && granted.has(capability.id),
  }));
}

function runtimeDiagnostic(instance: PluginInstanceRecord | undefined) {
  if (!instance?.lastRuntimeError) return {};
  return { diagnostic: diagnostic(instance.lastRuntimeError, instance.lifecycleRevision) };
}

export function projectPluginManagerCatalogCandidate(
  candidate: PluginManagerCatalogCandidate,
  snapshot: PluginInventorySnapshot,
  overrides: PluginManagerProjectionOverrides = {},
): PluginManagerListItem {
  const instance = snapshot.instances.find(
    (item) => item.pluginId === candidate.pluginId && item.lifecycleState === 'installed',
  );
  const packageRecord = candidatePackage(candidate, snapshot, instance);
  const installedManifest = instance ? packageRecord?.manifest : undefined;
  const grant = instance
    ? snapshot.grants.find((item) => item.pluginInstanceId === instance.pluginInstanceId)
    : undefined;
  const { artifact, config, auth, intent, live, activationTransition } = projectionState(
    candidate,
    instance,
    packageRecord,
    overrides,
  );
  const capabilitySummary = projectCapabilities(
    installedManifest ? pluginManagerCapabilitiesFromManifest(installedManifest) : candidate.capabilities,
    grant?.effectiveGrants ?? [],
    overrides.activeCapabilityIds ?? [],
  );

  return {
    pluginId: candidate.pluginId,
    pluginInstanceId: instance?.pluginInstanceId ?? null,
    displayName: installedManifest?.name ?? candidate.displayName,
    ...candidatePresentation(candidate, installedManifest),
    source: candidateSource(candidate, packageRecord),
    availableVersion: candidate.version,
    installedVersion: packageRecord?.version ?? null,
    packageDigest: instance?.packageDigest ?? candidate.packageDigest,
    artifact,
    config,
    auth,
    intent,
    live,
    lifecycleRevision: instance?.lifecycleRevision ?? null,
    capabilitySummary,
    actions: derivePluginManagerActions({ artifact, config, auth, intent, activationTransition }),
    ...runtimeDiagnostic(instance),
  };
}
