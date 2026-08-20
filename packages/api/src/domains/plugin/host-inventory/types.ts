import type { Capability, PluginManifest, SignalSchemaCatalog } from '@clowder-ai/plugin-contract';

export const PLUGIN_INVENTORY_SCHEMA_VERSION = 1 as const;

export type PackageState = 'staged' | 'verified' | 'installed' | 'quarantined';
export type InstanceLifecycleState = 'installed' | 'retired';
export type ConfigReadiness = 'incomplete' | 'ready';
export type ActivationState = 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error';
export type RuntimeState = 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
export type PluginRuntimeErrorCode =
  | 'AUTH_EXPIRED'
  | 'EVENT_BUS_CONFLICT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'UNEXPECTED_RUNTIME_FAILURE';

export interface PluginRuntimeErrorRecord {
  readonly code: PluginRuntimeErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly occurredAt: number;
}

export interface PluginPackageRecord {
  readonly packageDigest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly manifest: PluginManifest;
  /** Package-local schemas resolved from the exact admitted archive. */
  readonly signalSchemas: SignalSchemaCatalog;
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
  | 'INSTANCE_NOT_FOUND'
  | 'STALE_INSTANCE'
  | 'STALE_LIFECYCLE_REVISION'
  | 'STALE_GRANT_REVISION'
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
