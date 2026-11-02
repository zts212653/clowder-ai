import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { DesktopWindowFailureReason } from '../desktop-window-runtime/failure-reason.js';
import type { StoredPluginManifest } from './stored-manifest.js';

export const PLUGIN_INVENTORY_SCHEMA_VERSION = 1 as const;

export type PackageState = 'staged' | 'verified' | 'installed' | 'quarantined';
export type InstanceLifecycleState = 'installed' | 'retired';
export type ConfigReadiness = 'incomplete' | 'ready';
export type ActivationState = 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error';
export type RuntimeState = 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
export type PluginDependencyClosure = 'shipped' | 'materialized';
export type PluginPackageProvenance =
  | {
      readonly kind: 'catalog';
      readonly catalogId: string;
      readonly packageName: string;
      /** Optional admission-time hint; older installations do not acquire an origin from current discovery. */
      readonly ownerAuthRequired?: boolean;
    }
  | {
      readonly kind: 'local-directory' | 'local-archive';
      readonly packageName?: string;
      readonly dependencyClosure?: PluginDependencyClosure;
    }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly packageName?: string;
      readonly dependencyClosure?: PluginDependencyClosure;
    };
export type PluginRuntimeErrorCode =
  | 'AUTH_EXPIRED'
  | 'EVENT_BUS_CONFLICT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'UPDATE_RESUME_FAILED'
  | 'UPDATE_ROLLBACK_RESUME_FAILED'
  | 'CONFIGURATION_RESUME_FAILED'
  | 'CATCH_UP_RESUME_FAILED'
  | 'UNEXPECTED_RUNTIME_FAILURE';

export interface PluginRuntimeErrorRecord {
  readonly code: PluginRuntimeErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly occurredAt: number;
  /** Bounded first cause for the Host-owned desktop body; older snapshots omit it. */
  readonly desktopReason?: DesktopWindowFailureReason;
}

export interface PluginPackageRecord {
  readonly packageDigest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly manifest: PluginManifest | null;
  /** Historical bytes for display/replacement only; never an executable manifest. */
  readonly incompatibleManifest?: StoredPluginManifest;
  /** Package-local schemas resolved from the exact admitted archive. */
  readonly signalSchemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Admission origin is immutable package metadata, not an inference from current catalog reachability. */
  readonly provenance?: PluginPackageProvenance;
  readonly packageState: PackageState;
  readonly verifiedAt: number;
  readonly updatedAt: number;
}

export type ExecutablePluginPackageRecord = PluginPackageRecord & { readonly manifest: PluginManifest };

export interface PluginInstanceRecord {
  readonly pluginInstanceId: string;
  readonly pluginId: string;
  readonly packageDigest: string;
  readonly lifecycleState: InstanceLifecycleState;
  readonly configReadiness: ConfigReadiness;
  readonly activationState: ActivationState;
  readonly runtimeState: RuntimeState;
  /** Fence for owner-driven config/activation/lifecycle mutations. Runtime health does not advance it. */
  readonly lifecycleRevision: number;
  readonly installedAt: number;
  readonly updatedAt: number;
  readonly retiredAt?: number;
  /** Sanitized machine-readable failure only. Raw child stderr is never persisted. */
  readonly lastRuntimeError?: PluginRuntimeErrorRecord;
}

export interface PluginInventorySnapshot {
  readonly schemaVersion: typeof PLUGIN_INVENTORY_SCHEMA_VERSION;
  readonly packages: readonly PluginPackageRecord[];
  readonly instances: readonly PluginInstanceRecord[];
}

export interface PackageAdmissionCandidate {
  readonly manifest: unknown;
  /** Digest computed by the Host package verifier over the staged archive bytes. */
  readonly computedPackageDigest: string;
  /** Digest promised by the immutable package source/registry reservation. */
  readonly expectedPackageDigest: string;
  readonly packagePluginId: string;
  readonly signalSchemas?: PluginPackageRecord['signalSchemas'];
  readonly provenance?: PluginPackageProvenance;
}

export interface UpgradePackageInput extends PackageAdmissionCandidate {
  readonly pluginInstanceId: string;
  readonly expectedLifecycleRevision: number;
}

export interface ReinstallPackageInput extends PackageAdmissionCandidate {
  readonly previousPluginInstanceId: string;
}

export interface InventoryMutationResult {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
}

export type PluginInventoryErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_PACKAGE_DIGEST'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'PACKAGE_ID_MISMATCH'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'PACKAGE_ALREADY_INSTALLED'
  | 'DATA_DIRECTORY_IN_USE'
  | 'INSTANCE_NOT_FOUND'
  | 'STALE_INSTANCE'
  | 'STALE_LIFECYCLE_REVISION'
  | 'RUNTIME_NOT_STOPPED'
  | 'INSTANCE_ID_COLLISION'
  | 'INCOMPATIBLE_PACKAGE'
  | 'CORRUPT_SNAPSHOT'
  | 'UNSUPPORTED_SCHEMA'
  | 'INVENTORY_INVARIANT';

export class PluginInventoryError extends Error {
  constructor(
    readonly code: PluginInventoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginInventoryError';
  }
}
