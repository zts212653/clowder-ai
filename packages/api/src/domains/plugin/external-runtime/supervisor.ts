import process from 'node:process';
import { WIRE_VERSION } from '@clowder-ai/plugin-contract';
import type { BrokerConnection } from '../host-broker/builtin-loopback.js';
import type { PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord, RuntimeState } from '../host-inventory/types.js';
import { NodeExternalPluginProcessAdapter } from './node-process-adapter.js';
import { verifyExternalPackage } from './package-authority.js';
import { projectRuntimeCrash } from './runtime-crash-projection.js';
import { closeRuntimeExecutionResources } from './runtime-execution-cleanup.js';
import {
  createRuntimeHeartbeatController,
  type RuntimeHeartbeatController,
  type RuntimeHeartbeatPolicy,
  resolveRuntimeHeartbeatPolicy,
} from './runtime-heartbeat.js';
import { createExternalStdioBrokerTransport, type ExternalStdioBrokerTransport } from './stdio-broker-transport.js';
import type {
  ExternalPluginProcess,
  ExternalPluginRuntimeHandle,
  ExternalPluginRuntimeSupervisorOptions,
  VerifiedPluginPackage,
} from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

interface RunnableAuthority {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

interface RuntimeExecution {
  readonly pluginInstanceId: string;
  packageDigest: string;
  readonly ready: Deferred<void>;
  readonly closed: Deferred<void>;
  process?: ExternalPluginProcess;
  exit?: Awaited<ExternalPluginProcess['exited']>;
  locatedPackage?: VerifiedPluginPackage;
  connection?: BrokerConnection;
  transport?: ExternalStdioBrokerTransport;
  heartbeat?: RuntimeHeartbeatController;
  projected: boolean;
  started: boolean;
  ending: boolean;
  terminal?: Promise<void>;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class ExternalPluginRuntimeSupervisor {
  private readonly active = new Map<string, RuntimeExecution>();
  private readonly handshakeTimeoutMs: number;
  private readonly now: () => number;
  private readonly heartbeatPolicy: RuntimeHeartbeatPolicy;
  private readonly processes;

  constructor(private readonly options: ExternalPluginRuntimeSupervisorOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.heartbeatPolicy = resolveRuntimeHeartbeatPolicy(
      options.broker.activeRuntimeLeaseTtlMs,
      options.heartbeatIntervalMs,
      options.heartbeatTimeoutMs,
    );
    this.processes = options.processes ?? new NodeExternalPluginProcessAdapter();
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
    await Promise.all([...this.active.values()].map((execution) => this.finish(execution, reason, 'stopped', true)));
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
    const authority = await this.runnableAuthority(execution.pluginInstanceId);
    execution.packageDigest = authority.instance.packageDigest;
    if (authority.packageRecord.manifest.runtime.transport !== 'stdio') {
      throw new ExternalPluginRuntimeError(
        'UNSUPPORTED_TRANSPORT',
        `runtime transport ${authority.packageRecord.manifest.runtime.transport} is not executable by this Host`,
      );
    }
    const located = await this.options.packages.resolveInstalledPackage(authority.instance.packageDigest);
    execution.locatedPackage = located;
    const verified = await verifyExternalPackage(authority.packageRecord, located);
    await this.setRuntimeState(execution, 'starting');
    execution.projected = true;
    await located.verifyIntegrity();
    execution.process = await this.processes.spawn({
      command: process.execPath,
      args: [verified.entrypoint],
      cwd: verified.rootDir,
      env: {
        CLOWDER_PLUGIN_ID: authority.instance.pluginId,
        CLOWDER_PACKAGE_DIGEST: authority.instance.packageDigest,
        CLOWDER_CONTRACT_VERSION: authority.packageRecord.contractVersion,
        CLOWDER_WIRE_VERSION: WIRE_VERSION,
      },
    });
    void execution.process.exited.then((exit) => {
      execution.exit = exit;
      return this.finish(execution, 'process_exit', 'crashed', false);
    });
    this.assertOpen(execution);
    await this.setRuntimeState(execution, 'handshaking');
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
      onFailure: () => this.finish(execution, 'heartbeat_failure', 'crashed', true),
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

  private async runnableAuthority(pluginInstanceId: string): Promise<RunnableAuthority> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const current = instance
      ? snapshot.instances.find(
          (candidate) => candidate.pluginId === instance.pluginId && candidate.lifecycleState === 'installed',
        )
      : undefined;
    const packageRecord = instance
      ? snapshot.packages.find(
          (candidate) => candidate.packageDigest === instance.packageDigest && candidate.packageState === 'installed',
        )
      : undefined;
    if (
      !instance ||
      current?.pluginInstanceId !== pluginInstanceId ||
      instance.lifecycleState !== 'installed' ||
      instance.configReadiness !== 'ready' ||
      instance.activationState !== 'enabled' ||
      (instance.runtimeState !== 'stopped' && instance.runtimeState !== 'crashed') ||
      !packageRecord
    ) {
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', `${pluginInstanceId} is not a runnable instance`);
    }
    return { instance, packageRecord };
  }

  private async setRuntimeState(execution: RuntimeExecution, runtimeState: RuntimeState): Promise<void> {
    await this.options.inventory.transaction((transaction: PluginInventoryTransaction) => {
      const instance = transaction.instances.get(execution.pluginInstanceId);
      if (
        !instance ||
        instance.lifecycleState !== 'installed' ||
        instance.packageDigest !== execution.packageDigest ||
        instance.configReadiness !== 'ready' ||
        instance.activationState !== 'enabled'
      ) {
        throw new ExternalPluginRuntimeError(
          'INSTANCE_NOT_RUNNABLE',
          `${execution.pluginInstanceId} authority changed before runtime projection`,
        );
      }
      if (runtimeState === 'starting') {
        const { lastRuntimeError: _lastRuntimeError, ...withoutRuntimeError } = instance;
        transaction.instances.put({ ...withoutRuntimeError, runtimeState, updatedAt: this.now() });
      } else {
        transaction.instances.put({ ...instance, runtimeState, updatedAt: this.now() });
      }
    });
  }

  private finish(
    execution: RuntimeExecution,
    reason: string,
    terminalState: 'stopped' | 'crashed',
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
    terminalState: 'stopped' | 'crashed',
    terminateProcess: boolean,
  ): Promise<void> {
    execution.heartbeat?.stop();
    execution.transport?.close();
    await closeRuntimeExecutionResources(execution, reason, terminateProcess);
    await this.projectTerminalState(execution, terminalState);
    this.active.delete(execution.pluginInstanceId);
    execution.closed.resolve(undefined);
  }

  private async projectTerminalState(execution: RuntimeExecution, terminalState: 'stopped' | 'crashed'): Promise<void> {
    if (execution.projected && terminalState === 'crashed') {
      await projectRuntimeCrash(this.options.inventory, execution, this.now).catch(() => undefined);
      return;
    }
    if (execution.projected && !execution.connection) {
      await this.setRuntimeState(execution, 'stopped').catch(() => undefined);
    }
  }

  private assertOpen(execution: RuntimeExecution): void {
    if (execution.ending) {
      throw new ExternalPluginRuntimeError('PROCESS_EXITED', `${execution.pluginInstanceId} process authority ended`);
    }
  }
}
