import type { DesktopWindowContribution } from '@clowder-ai/plugin-contract';
import type { StaticSurfaceServer } from '../external-runtime/static-surface-server.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { BuiltinBrokerConnection } from '../host-broker/builtin-loopback.js';
import type { HostBrokerControlPlane } from '../host-broker/control-plane.js';
import type { HostBrokerStore } from '../host-broker/ports.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { HostCompanionReply as CompanionReply } from './companion-private-wire.js';
import type { DesktopWindowObserver } from './observer.js';
import type { CompanionArchiveContract } from './published-companion-v2.js';

export interface DesktopCompanionBridge {
  request(input: unknown): Promise<CompanionReply>;
  close(): Promise<void>;
}

export type DesktopWindowVisibility = 'visible' | 'hidden';
export type DesktopWindowFailureReason =
  | 'renderer-gone'
  | 'unresponsive'
  | 'window-closed'
  | 'process-exit'
  | 'request-timeout'
  | 'protocol-violation'
  | 'connection-ended'
  | 'heartbeat-expired'
  | 'poll-failed'
  | 'surface-unavailable'
  | 'unknown';
export interface DesktopWindowFailure {
  readonly reason: DesktopWindowFailureReason;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Terminal owner, so an abort-induced child callback cannot masquerade as the first cause. */
  readonly initiator?: 'executor' | 'host-observer' | 'surface';
  /** Bounded, content-free evidence about a Host observation in progress at loss. */
  readonly observation?: {
    readonly phase: 'poll' | 'authority' | 'lease-renew';
    readonly pending: boolean;
    readonly startedAtMs: number;
    readonly deadlineAtMs: number;
    readonly elapsedMs: number;
    readonly lastPollAnswerAgeMs: number | null;
  };
  /** Only emitted to Host diagnostics; never persisted as plugin identity. */
  readonly pid?: number;
  readonly lastStage?: string | null;
}
export interface DesktopWindowLaunch {
  readonly url: string;
  readonly presentation: DesktopWindowContribution['presentation'];
  /** Present only for the exact verified public archive that carries the new contract. */
  readonly publicCompanionV2?: true;
  readonly companionContract?: CompanionArchiveContract['contract'];
  readonly signal: AbortSignal;
  readonly onClosed: (failure?: DesktopWindowFailure) => void;
  readonly request?: (input: unknown) => Promise<CompanionReply>;
}
/** A trusted Host-owned executable, never a package-supplied main/preload script. */
export interface DesktopWindowExecutor {
  open(input: DesktopWindowLaunch): Promise<DesktopWindowHandle>;
}
export interface DesktopWindowHandle {
  /** Query the actual child. A Host timer alone is not a liveness witness. */
  poll(): Promise<DesktopWindowVisibility>;
  show(): Promise<void>;
  /** Revoke only capture in the trusted child and await its acknowledgement. */
  revokeMedia?(): Promise<void>;
  navigate?(url: string): Promise<void>;
  close(): Promise<void>;
}
export interface DesktopWindowPresence {
  readonly pluginInstanceId: string;
  readonly contributionId: string;
  readonly state: DesktopWindowVisibility;
  readonly observedAt: number;
  readonly expiresAt: number;
}

export interface ActiveWindow {
  readonly id: string;
  readonly digest: string;
  readonly lifecycleRevision: number;
  readonly package: VerifiedPluginPackage;
  readonly connection: BuiltinBrokerConnection;
  readonly controller: AbortController;
  server?: StaticSurfaceServer;
  window?: DesktopWindowHandle;
  observer?: DesktopWindowObserver;
  bridge?: DesktopCompanionBridge;
  lease?: string;
  closing?: Promise<void>;
  ready: boolean;
}

export interface DesktopWindowRuntimeOptions {
  readonly inventory: PluginInventoryStore;
  readonly brokerStore: HostBrokerStore;
  readonly broker: HostBrokerControlPlane;
  readonly packages: VerifiedPluginPackageLocator;
  readonly executor: DesktopWindowExecutor;
  /** Trusted composition catalog; production uses the immutable published table. */
  readonly companionArchives?: readonly CompanionArchiveContract[];
  readonly now?: () => number;
  readonly onFailure?: (id: string, failure: DesktopWindowFailure) => void;
  readonly createBridge?: (context: {
    assertCurrent(): Promise<void>;
    navigate(url: string): Promise<boolean>;
    publicCompanionV2: boolean;
    companionContract?: CompanionArchiveContract['contract'];
    disableCompanion?(): Promise<void>;
  }) => DesktopCompanionBridge;
  readonly disableCompanion?: (id: string, expectedRevision: number) => Promise<void>;
}
