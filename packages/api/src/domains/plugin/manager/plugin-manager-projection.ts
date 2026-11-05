import type {
  PluginDescription,
  PluginIconSpec,
  PluginManagerActions,
  PluginManagerArtifactState,
  PluginManagerAuthState,
  PluginManagerConfigState,
  PluginManagerContribution,
  PluginManagerIntentState,
  PluginManagerListItem,
  PluginManagerLiveState,
  PluginManagerPackageSource,
} from '@cat-cafe/shared';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { hasRetainedDesktopLoss } from '../desktop-window-runtime/desktop-loss.js';
import { pluginRuntimeDiagnostic } from '../diagnostics/plugin-runtime-diagnostic.js';
import type { PluginInstanceRecord, PluginInventorySnapshot, PluginPackageRecord } from '../host-inventory/types.js';
import { sourceSemver } from './local-directory-semver.js';

/** Catalog-owned metadata required to render an available plugin before installation. */
export interface PluginManagerCatalogCandidate {
  readonly catalogId: string;
  readonly sourceLabel?: string;
  /** A catalog candidate with a current validated manifest, never an inventory fallback. */
  readonly compatibleReplacement?: boolean;
  /** Trusted exact archive release; full package compatibility is checked before replacement. */
  readonly updateRequiresValidation?: boolean;
  readonly pluginId: string;
  readonly packageName: string;
  readonly version: string;
  readonly packageDigest: string | null;
  readonly directorySource?: Extract<PluginManagerPackageSource, { kind: 'git' }>;
  readonly displayName: string;
  readonly description?: PluginDescription;
  readonly icon?: PluginIconSpec;
  readonly iconBg?: string;
  readonly publisher?: string;
  readonly ownerAuthRequired: boolean;
  readonly contributions?: readonly PluginManagerContribution[];
}

export interface PluginManagerProjectionOverrides {
  /** Typed auth contribution. Runtime health must never be used as an auth proxy. */
  readonly authState?: PluginManagerAuthState;
  /** Config service projection; Host inventory currently represents ready/incomplete only. */
  readonly configState?: PluginManagerConfigState;
  /** Desired intent reader override for lifecycle error states where activationState is ambiguous. */
  readonly intentState?: PluginManagerIntentState;
}

export interface DerivePluginManagerActionsInput {
  readonly artifact: PluginManagerArtifactState;
  readonly config: PluginManagerConfigState;
  readonly auth: PluginManagerAuthState;
  readonly intent: PluginManagerIntentState;
  readonly activationTransition: boolean;
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

/** Projects verified package contributions as the user-facing installed integration surface. */
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
      trust: 'unverified',
      ...(provenance.dependencyClosure === undefined ? {} : { dependencyClosure: provenance.dependencyClosure }),
    };
  }
  if (provenance?.kind === 'git') {
    return {
      kind: 'git',
      url: provenance.url,
      packageName: provenance.packageName ?? null,
      trust: 'unverified',
      ...(provenance.dependencyClosure === undefined ? {} : { dependencyClosure: provenance.dependencyClosure }),
    };
  }
  if (packageRecord && provenance?.kind !== 'catalog') {
    // Display existing installations without inventing an admission source or changing their authority.
    return { kind: 'unknown', packageName: null, trust: 'unknown' };
  }
  if (candidate.directorySource && !packageRecord) return candidate.directorySource;
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

function runtimeDiagnostic(instance: PluginInstanceRecord | undefined) {
  const diagnostic = pluginRuntimeDiagnostic(instance);
  return diagnostic === undefined ? {} : { diagnostic };
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
  const installedManifest = instance ? (packageRecord?.manifest ?? undefined) : undefined;
  const incompatible = packageRecord?.manifest === null;
  const { artifact, config, auth, intent, live, activationTransition } = projectionState(
    candidate,
    instance,
    packageRecord,
    overrides,
  );

  const newerRelease =
    (candidate.compatibleReplacement === true || candidate.updateRequiresValidation === true) &&
    packageRecord !== undefined &&
    sourceSemver.valid(candidate.version) !== null &&
    sourceSemver.valid(packageRecord.version) !== null &&
    sourceSemver.gt(candidate.version, packageRecord.version);

  return {
    pluginId: candidate.pluginId,
    pluginInstanceId: instance?.pluginInstanceId ?? null,
    displayName: installedManifest?.name ?? packageRecord?.incompatibleManifest?.name ?? candidate.displayName,
    ...candidatePresentation(candidate, installedManifest),
    source: candidateSource(candidate, packageRecord),
    availableVersion: candidate.version,
    installedVersion: packageRecord?.version ?? null,
    packageDigest: instance?.packageDigest ?? candidate.packageDigest,
    artifact,
    config,
    auth,
    intent,
    live: incompatible ? 'stopped' : live,
    ...(instance?.activationState === 'error' ? { activationFailed: true } : {}),
    lifecycleRevision: instance?.lifecycleRevision ?? null,
    capabilitySummary: [],
    actions: incompatible
      ? {
          install: newerRelease,
          setEnabled: false,
          uninstall: true,
          blockingReasons: ['package-incompatible'],
        }
      : {
          ...derivePluginManagerActions({ artifact, config, auth, intent, activationTransition }),
          ...(artifact === 'installed' &&
          config === 'ready' &&
          (auth === 'connected' || auth === 'not-required') &&
          !activationTransition &&
          (instance?.activationState === 'error' ||
            (intent === 'enabled' && live === 'crashed') ||
            (instance?.pluginId === 'official.companion' && hasRetainedDesktopLoss(instance)))
            ? { repair: true }
            : {}),
          ...(artifact === 'installed' && newerRelease && !activationTransition ? { install: true } : {}),
        },
    ...(incompatible
      ? {
          diagnostic: {
            code: 'PACKAGE_INCOMPATIBLE',
            message: newerRelease
              ? '插件版本与当前 Host 不兼容，已停止运行。配置与数据已保留，可尝试更新，安装前会校验兼容性。'
              : '插件版本与当前 Host 不兼容，已停止运行。配置与数据已保留；当前无可用更新。',
            occurredAt: packageRecord.updatedAt,
            revision: instance?.lifecycleRevision ?? null,
          },
        }
      : runtimeDiagnostic(instance)),
  };
}
