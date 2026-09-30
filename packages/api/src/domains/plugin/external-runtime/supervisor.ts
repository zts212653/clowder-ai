import process from 'node:process';
import {
  type M0CDeliverInput,
  type M0CDeliverResult,
  WIRE_METHOD_REGISTRY,
  WIRE_VERSION,
} from '@clowder-ai/plugin-contract';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import type { BrokerConnection } from '../host-broker/builtin-loopback.js';
import { HostBrokerError } from '../host-broker/types.js';
import type { PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { RuntimeState } from '../host-inventory/types.js';
import { NodeExternalPluginProcessAdapter } from './node-process-adapter.js';
import { verifyPackageEntrypoint } from './package-entrypoint-authority.js';
import { deferred, type RuntimeExecution } from './runtime-execution.js';
import { closeRuntimeExecutionResources } from './runtime-execution-cleanup.js';
import {
  createRuntimeHeartbeatController,
  type RuntimeHeartbeatController,
  type RuntimeHeartbeatPolicy,
  resolveRuntimeHeartbeatPolicy,
} from './runtime-heartbeat.js';
import { projectRuntimeReplacementFailure, RuntimeLeaseRecoveryCoordinator } from './runtime-lease-recovery.js';
import { projectTerminalState, type RuntimeProjectionDeps, setRuntimeState } from './runtime-state-projection.js';
import {
  assertAuthorityUnchanged,
  projectStartConfiguration,
  type RunnableAuthority,
  resolveRunnableAuthority,
} from './start-authority.js';
import { createExternalStdioBrokerTransport, type ExternalStdioBrokerTransport } from './stdio-broker-transport.js';
import type {
  ExternalPluginProcess,
  ExternalPluginRuntimeHandle,
  ExternalPluginRuntimeSupervisorOptions,
  VerifiedPluginPackage,
} from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const TRANSIENT_EXIT_RECOVERY_COOLDOWN_MS = 5 * 60_000;

export class ExternalPluginRuntimeSupervisor {
  private readonly active = new Map<string, RuntimeExecution>();
  readonly handshakeTimeoutMs: number;
  private readonly now: () => number;
  private readonly heartbeatPolicy: RuntimeHeartbeatPolicy;
  private readonly processes;
  private readonly recovery: RuntimeLeaseRecoveryCoordinator;
  private readonly transientRecoveryAt = new Map<string, number>();
  /** The two collaborators every runtime-state write needs, bound once. */
  private readonly projection: RuntimeProjectionDeps;

  constructor(private readonly options: ExternalPluginRuntimeSupervisorOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.projection = { inventory: options.inventory, now: () => this.now() };
    this.heartbeatPolicy = resolveRuntimeHeartbeatPolicy(
      options.broker.activeRuntimeLeaseTtlMs,
      options.heartbeatIntervalMs,
      options.heartbeatTimeoutMs,
    );
    this.processes = options.processes ?? new NodeExternalPluginProcessAdapter();
    this.recovery = new RuntimeLeaseRecoveryCoordinator({
      startReplacement: async (pluginInstanceId) => {
        await this.start(pluginInstanceId);
      },
      projectFailure: (target) => projectRuntimeReplacementFailure(options.inventory, target, this.now),
    });
  }

  /** The child-process carrier. Every transport other than the Host's own in-process
   * one is a package that runs beside the Host, so it is carried here. */
  claims({ packageRecord }: PluginRuntimeAdmission): boolean {
    return packageRecord.manifest.runtime !== undefined && packageRecord.manifest.runtime.transport !== 'builtin';
  }

  start(pluginInstanceId: string): Promise<ExternalPluginRuntimeHandle> {
    if (this.active.has(pluginInstanceId)) {
      return Promise.reject(
        new ExternalPluginRuntimeError('RUNTIME_ALREADY_ACTIVE', `${pluginInstanceId} already has a process owner`),
      );
    }
    const execution: RuntimeExecution = {
      pluginInstanceId,
      packageDigest: '',
      ready: deferred<void>(),
      closed: deferred<void>(),
      projected: false,
      started: false,
      ending: false,
    };
    this.active.set(pluginInstanceId, execution);
    return this.startOwned(execution).catch(async (error) => {
      await this.finish(execution, 'start_failed', execution.process ? 'crashed' : 'stopped', true);
      throw error;
    });
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const execution = this.active.get(pluginInstanceId);
    if (!execution) return;
    await this.finish(execution, reason, 'stopped', true);
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    this.recovery.stopAccepting();
    await Promise.all([...this.active.values()].map((execution) => this.finish(execution, reason, 'stopped', true)));
  }

  async deliver(pluginInstanceId: string, input: M0CDeliverInput): Promise<M0CDeliverResult> {
    const execution = this.active.get(pluginInstanceId);
    if (!execution?.started || execution.ending || !execution.transport) {
      try {
        await this.options.broker.authorizeHostDelivery(pluginInstanceId);
      } catch (error) {
        throw new ExternalPluginRuntimeError(
          'DELIVERY_REJECTED',
          `${pluginInstanceId} failed Host delivery admission before runtime dispatch`,
          { cause: error },
        );
      }
      throw new ExternalPluginRuntimeError(
        'DELIVERY_REJECTED',
        `${pluginInstanceId} has no active stdio runtime for Host delivery`,
      );
    }
    try {
      await this.options.broker.authorizeHostCall(
        pluginInstanceId,
        WIRE_METHOD_REGISTRY['host.messaging.deliver'].grant,
      );
    } catch (error) {
      await this.finish(execution, 'authority_changed', 'stopped', true);
      throw new ExternalPluginRuntimeError(
        'DELIVERY_REJECTED',
        `${pluginInstanceId} lost onMessage authority before Host delivery`,
        { cause: error },
      );
    }
    this.assertOpen(execution);
    return execution.transport.call('host.messaging.deliver', input);
  }

  invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    if (method !== 'host.messaging.deliver') {
      return Promise.reject(
        new ExternalPluginRuntimeError(
          'DELIVERY_REJECTED',
          `${pluginInstanceId} stdio runtime does not expose Host action ${method}`,
        ),
      );
    }
    return this.deliver(pluginInstanceId, params as M0CDeliverInput);
  }

  async recoverAfterRestart(): Promise<number> {
    if (this.active.size > 0) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        'restart recovery requires a fresh supervisor with no process authority',
      );
    }
    return this.options.broker.recoverAfterRestart();
  }

  private async startOwned(execution: RuntimeExecution): Promise<ExternalPluginRuntimeHandle> {
    const authority = await resolveRunnableAuthority(this.options, execution.pluginInstanceId);
    execution.packageDigest = authority.instance.packageDigest;
    const { runtime } = authority.packageRecord.manifest;
    if (runtime?.transport !== 'stdio') {
      throw new ExternalPluginRuntimeError(
        'UNSUPPORTED_TRANSPORT',
        `runtime transport ${runtime?.transport ?? 'none'} is not executable by this Host`,
      );
    }
    const located = await this.options.packages.resolveInstalledPackage(authority.instance.packageDigest);
    execution.locatedPackage = located;
    const verified = await verifyPackageEntrypoint(authority.packageRecord, located);
    await setRuntimeState(this.projection, execution, 'starting');
    execution.projected = true;
    await located.verifyIntegrity();
    // F202 C1 gap C: manifest-declared config/secrets, grant-checked and fail-closed. Declared
    // fields are resolved BEFORE the protocol variables are written, and a declared key inside
    // the CLOWDER_ namespace is refused outright, so a package can never restate its own
    // Host-issued identity by shadowing one of them.
    const declaredEnv = await projectStartConfiguration(this.options, authority);
    // The authority above was read before package resolution, integrity verification and the
    // configuration read. A revoke landing in that window is legal for this instance, so the
    // values resolved from the old snapshot must not reach a child without revalidation
    // (sixth-round review P1) — the same authority fence every carrier must apply before
    // handing a package any Host-owned value.
    await assertAuthorityUnchanged(this.options, authority, 'starting');
    execution.process = await this.processes.spawn({
      command: process.execPath,
      args: [verified.entrypoint],
      cwd: verified.rootDir,
      env: {
        ...declaredEnv,
        CLOWDER_PLUGIN_ID: authority.instance.pluginId,
        CLOWDER_PACKAGE_DIGEST: authority.instance.packageDigest,
        CLOWDER_CONTRACT_VERSION: authority.packageRecord.contractVersion,
        CLOWDER_WIRE_VERSION: WIRE_VERSION,
      },
    });
    void execution.process.exited.then((exit) => {
      execution.exit = exit;
      const terminalState = this.canRecoverTransientExit(execution, exit) ? 'restartable' : 'crashed';
      return this.finish(execution, 'process_exit', terminalState, false);
    });
    this.assertOpen(execution);
    await setRuntimeState(this.projection, execution, 'handshaking');
    execution.connection = await this.options.broker.openExternalConnection(execution.pluginInstanceId);
    this.assertOpen(execution);
    execution.transport = createExternalStdioBrokerTransport({
      process: execution.process,
      connection: execution.connection,
      onReady: () => execution.ready.resolve(undefined),
      onFatal: () => {
        void this.finish(execution, 'transport_failure', 'crashed', true);
      },
      now: this.now,
      heartbeatTimeoutMs: this.heartbeatPolicy.timeoutMs,
    });
    await this.waitForReady(execution);
    this.assertOpen(execution);
    execution.started = true;
    const transport = execution.transport;
    const connection = execution.connection;
    execution.heartbeat = createRuntimeHeartbeatController({
      intervalMs: this.heartbeatPolicy.intervalMs,
      ping: () => transport.ping(),
      renewLease: () => connection.renewRuntimeLease(),
      onFailure: (error) => this.handleHeartbeatFailure(execution, error),
    });
    execution.heartbeat.start();
    return { pluginInstanceId: execution.pluginInstanceId, closed: execution.closed.promise };
  }

  private async waitForReady(execution: RuntimeExecution): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ExternalPluginRuntimeError(
            'HANDSHAKE_TIMEOUT',
            `${execution.pluginInstanceId} did not complete the Host handshake in time`,
          ),
        );
      }, this.handshakeTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([
        execution.ready.promise,
        execution.closed.promise.then(() => {
          throw new ExternalPluginRuntimeError(
            'PROCESS_EXITED',
            `${execution.pluginInstanceId} process authority ended before broker.ready`,
          );
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private finish(
    execution: RuntimeExecution,
    reason: string,
    terminalState: 'stopped' | 'crashed' | 'restartable',
    terminateProcess: boolean,
  ): Promise<void> {
    if (execution.terminal) return execution.terminal;
    execution.ending = true;
    execution.terminal = this.finishOwned(execution, reason, terminalState, terminateProcess);
    return execution.terminal;
  }

  private async finishOwned(
    execution: RuntimeExecution,
    reason: string,
    terminalState: 'stopped' | 'crashed' | 'restartable',
    terminateProcess: boolean,
  ): Promise<void> {
    execution.heartbeat?.stop();
    execution.transport?.close();
    await closeRuntimeExecutionResources(execution, reason, terminateProcess);
    await projectTerminalState(this.projection, execution, terminalState);
    this.active.delete(execution.pluginInstanceId);
    execution.closed.resolve(undefined);
    if (terminalState === 'restartable') {
      this.recovery.request({
        pluginInstanceId: execution.pluginInstanceId,
        packageDigest: execution.packageDigest,
      });
    }
  }

  private async handleHeartbeatFailure(execution: RuntimeExecution, error: unknown): Promise<void> {
    let classifiedError = error;
    if (error instanceof ExternalPluginRuntimeError && error.code === 'HEARTBEAT_TIMEOUT' && execution.connection) {
      try {
        await execution.connection.renewRuntimeLease();
      } catch (leaseError) {
        classifiedError = leaseError;
      }
    }
    if (
      classifiedError instanceof HostBrokerError &&
      classifiedError.code === 'SESSION_NOT_ACTIVE' &&
      classifiedError.sessionCloseReason === 'runtime_lease_expired'
    ) {
      await this.finish(execution, 'runtime_lease_expired', 'restartable', true);
      return;
    }
    await this.finish(execution, 'heartbeat_failure', 'crashed', true);
  }

  private canRecoverTransientExit(
    execution: RuntimeExecution,
    exit: Awaited<ExternalPluginProcess['exited']>,
  ): boolean {
    if (execution.ending || !execution.started || exit.diagnostic?.code !== 'UNAVAILABLE') return false;
    const currentTime = this.now();
    const previousRecoveryAt = this.transientRecoveryAt.get(execution.pluginInstanceId);
    if (previousRecoveryAt !== undefined && currentTime - previousRecoveryAt < TRANSIENT_EXIT_RECOVERY_COOLDOWN_MS) {
      return false;
    }
    this.transientRecoveryAt.set(execution.pluginInstanceId, currentTime);
    return true;
  }

  private assertOpen(execution: RuntimeExecution): void {
    if (execution.ending) {
      throw new ExternalPluginRuntimeError('PROCESS_EXITED', `${execution.pluginInstanceId} process authority ended`);
    }
  }
}
