import type { Capability, PluginManifest, SignalSchemaCatalog } from '@clowder-ai/plugin-contract';
import type { DesktopWindowFailureReason } from '../desktop-window-runtime/types.js';

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
      /** Immutable admission metadata; absent legacy records fail closed while discovery is offline. */
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

/**
 * F202 W2-6b — what the Host knows about a failure beyond its `lastRuntimeError` code. It sits
 * beside that record instead of inside it, so a Host from before it reads the record unchanged and
 * drops this (its instance parser keeps only the fields it knows). A diagnostic only: no grant
 * decision reads it.
 *
 * It explains one failure of one package, and nothing after it: when the failure is replaced or the
 * instance's package changes, it is stale — a new version is never judged by what an old one did.
 */
export interface PluginRuntimeErrorDetail {
  /** The failure was the Host refusing a capability the instance was not granted. */
  readonly kind: 'capability_not_granted';
  readonly capability: Capability;
  /** The `occurredAt` of the `lastRuntimeError` it explains. */
  readonly occurredAt: number;
  /** The package that was starting when the Host refused it. */
  readonly packageDigest: string;
}

export interface PluginPackageRecord {
  readonly packageDigest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly manifest: PluginManifest;
  /** Package-local schemas resolved from the exact admitted archive. */
  readonly signalSchemas: SignalSchemaCatalog;
  /** Admission origin is immutable package metadata, not an inference from current catalog reachability. */
  readonly provenance?: PluginPackageProvenance;
  readonly packageState: PackageState;
  readonly verifiedAt: number;
  readonly updatedAt: number;
}

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
  /** Written and cleared with `lastRuntimeError`; see {@link PluginRuntimeErrorDetail}. */
  readonly lastRuntimeErrorDetail?: PluginRuntimeErrorDetail;
}

export interface PluginGrantRecord {
  readonly pluginInstanceId: string;
  readonly requestedCapabilities: readonly Capability[];
  readonly effectiveGrants: readonly Capability[];
  readonly grantRevision: number;
  readonly updatedAt: number;
}

export interface PluginInventorySnapshot {
  readonly schemaVersion: typeof PLUGIN_INVENTORY_SCHEMA_VERSION;
  readonly packages: readonly PluginPackageRecord[];
  readonly instances: readonly PluginInstanceRecord[];
  readonly grants: readonly PluginGrantRecord[];
}

export interface PackageAdmissionCandidate {
  readonly manifest: unknown;
  /** Digest computed by the Host package verifier over the staged archive bytes. */
  readonly computedPackageDigest: string;
  /** Digest promised by the immutable package source/registry reservation. */
  readonly expectedPackageDigest: string;
  readonly packagePluginId: string;
  readonly effectiveGrants: readonly string[];
  readonly signalSchemas?: SignalSchemaCatalog;
  readonly provenance?: PluginPackageProvenance;
}

export interface UpgradePackageInput extends PackageAdmissionCandidate {
  readonly pluginInstanceId: string;
  readonly expectedLifecycleRevision: number;
  readonly expectedGrantRevision: number;
}

export interface ReinstallPackageInput extends PackageAdmissionCandidate {
  readonly previousPluginInstanceId: string;
}

export interface RevokeGrantInput {
  readonly pluginInstanceId: string;
  readonly capability: string;
  readonly expectedGrantRevision: number;
}

/** F202 W2-6: what a Host-owned policy now allows the instance; its requests still bound the grant. */
export interface ReconcileGrantsInput {
  readonly pluginInstanceId: string;
  readonly allowedCapabilities: readonly string[];
  readonly expectedGrantRevision: number;
}

export interface InventoryMutationResult {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
}

export type PluginInventoryErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_PACKAGE_DIGEST'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'PACKAGE_ID_MISMATCH'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'INVALID_GRANT'
  | 'PACKAGE_ALREADY_INSTALLED'
  | 'DATA_DIRECTORY_IN_USE'
  | 'INSTANCE_NOT_FOUND'
  | 'STALE_INSTANCE'
  | 'STALE_LIFECYCLE_REVISION'
  | 'STALE_GRANT_REVISION'
  | 'RUNTIME_NOT_STOPPED'
  | 'INSTANCE_ID_COLLISION'
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
