import type { Readable, Writable } from 'node:stream';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { HostBrokerControlPlane } from '../host-broker/control-plane.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginRuntimeErrorCode } from '../host-inventory/types.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';

export type ExternalPluginRuntimeErrorCode =
  | 'INSTANCE_NOT_RUNNABLE'
  | 'RUNTIME_ALREADY_ACTIVE'
  | 'UNSUPPORTED_TRANSPORT'
  | 'PACKAGE_AUTHORITY_MISMATCH'
  | 'INVALID_PACKAGE_ROOT'
  | 'INVALID_ENTRYPOINT'
  | 'PROCESS_START_FAILED'
  | 'PROCESS_EXITED'
  | 'HANDSHAKE_TIMEOUT'
  | 'HEARTBEAT_TIMEOUT'
  | 'HEARTBEAT_REJECTED'
  | 'DELIVERY_REJECTED'
  | 'CONFIG_UNAVAILABLE'
  | 'PROTOCOL_VIOLATION';

export class ExternalPluginRuntimeError extends Error {
  constructor(
    readonly code: ExternalPluginRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExternalPluginRuntimeError';
  }
}

export interface VerifiedPluginPackage {
  readonly rootDir: string;
  readonly manifest: PluginManifest;
  /** Re-check the launchable tree against the in-memory snapshot derived from the admitted archive. */
  verifyIntegrity(): Promise<void>;
  /** Release the private per-runtime staging directory after the process is gone. */
  release(): Promise<void>;
}

export interface VerifiedPluginPackageLocator {
  resolveInstalledPackage(packageDigest: string): Promise<VerifiedPluginPackage>;
}

export interface ExternalPluginBootstrapEnvironment {
  readonly CLOWDER_PLUGIN_ID: string;
  readonly CLOWDER_PACKAGE_DIGEST: string;
  readonly CLOWDER_CONTRACT_VERSION: string;
  readonly CLOWDER_WIRE_VERSION: string;
}

export interface ExternalPluginProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: ExternalPluginBootstrapEnvironment;
}

export interface ExternalPluginProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly diagnostic?: { readonly code: PluginRuntimeErrorCode };
}

export interface ExternalPluginProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;
  readonly exited: Promise<ExternalPluginProcessExit>;
  terminate(): Promise<void>;
}

export interface ExternalPluginProcessAdapter {
  spawn(spec: ExternalPluginProcessSpec): Promise<ExternalPluginProcess>;
}

export interface ExternalPluginRuntimeHandle {
  readonly pluginInstanceId: string;
  readonly closed: Promise<void>;
}

export interface ExternalPluginRuntimeSupervisorOptions {
  readonly inventory: PluginInventoryStore;
  /**
   * F202 C1 gap C: reads the instance's stored configuration so manifest-declared fields can be
   * projected into the child's environment. Absent means no projection — a package then receives
   * only the protocol variables, which is the pre-C1 behaviour.
   */
  readonly configuration?: PluginRuntimeConfigurationPort;
  readonly broker: HostBrokerControlPlane;
  readonly packages: VerifiedPluginPackageLocator;
  readonly processes?: ExternalPluginProcessAdapter;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly now?: () => number;
}
