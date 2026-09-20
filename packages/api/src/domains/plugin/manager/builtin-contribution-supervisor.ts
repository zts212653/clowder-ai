import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import type { ConfigurationField, McpContribution, PluginManifest } from '@clowder-ai/plugin-contract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import type {
  PluginGrantRecord,
  PluginInstanceRecord,
  PluginPackageRecord,
  RuntimeState,
} from '../host-inventory/types.js';
import { effectivePluginConfigurationValue } from './plugin-configuration-values.js';

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface MaterializedBuiltinPluginPackage {
  readonly rootDir: string;
  verifyIntegrity(): Promise<void>;
  release(): Promise<void>;
}

export interface BuiltinPluginPackageMaterializer {
  resolve(input: {
    readonly pluginInstanceId: string;
    readonly pluginId: string;
    readonly packageDigest: string;
    readonly packageName?: string;
  }): Promise<MaterializedBuiltinPluginPackage>;
}

export interface PluginContributionConfigurationPort {
  readConfig(pluginInstanceId: string, key: string): Promise<unknown>;
  readSecret(pluginInstanceId: string, key: string): Promise<string | undefined>;
}

export interface McpContributionLaunchSpec {
  readonly pluginInstanceId: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Ephemeral child environment. Implementations must never persist this object. */
  readonly env: Readonly<Record<string, string>>;
}

export interface McpContributionRuntimeHandle {
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: {
      readonly type: 'object';
      readonly properties?: Readonly<Record<string, object>>;
      readonly required?: readonly string[];
      readonly $schema?: string;
    };
  }[];
  /** Resolves when the owned transport loses liveness after startup. */
  readonly closed?: Promise<{ readonly error?: Error }>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export interface BuiltinPluginContributionTool {
  readonly contributionId: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: McpContributionRuntimeHandle['tools'][number]['inputSchema'];
}

export interface McpContributionRuntimePort {
  start(spec: McpContributionLaunchSpec): Promise<McpContributionRuntimeHandle>;
}

export interface BuiltinPluginContributionSupervisorOptions {
  readonly inventory: PluginInventoryStore;
  readonly materializer: BuiltinPluginPackageMaterializer;
  readonly configuration: PluginContributionConfigurationPort;
  readonly runtime?: McpContributionRuntimePort;
  readonly now?: () => number;
}

export class BuiltinPluginContributionError extends Error {
  constructor(
    readonly code:
      | 'INSTANCE_NOT_RUNNABLE'
      | 'RUNTIME_ALREADY_ACTIVE'
      | 'UNSUPPORTED_CONTRIBUTION'
      | 'CONFIG_UNAVAILABLE'
      | 'INVALID_ENTRYPOINT'
      | 'START_FAILED'
      | 'STOP_FAILED'
      | 'CONTRIBUTION_NOT_ACTIVE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BuiltinPluginContributionError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function closeBounded(transport: StdioClientTransport): Promise<void> {
  return withTimeout(transport.close(), CLOSE_TIMEOUT_MS, 'MCP contribution close');
}

export class StdioMcpContributionRuntime implements McpContributionRuntimePort {
  constructor(
    private readonly options: {
      readonly startTimeoutMs?: number;
      readonly callTimeoutMs?: number;
    } = {},
  ) {}

  async start(spec: McpContributionLaunchSpec): Promise<McpContributionRuntimeHandle> {
    const server: StdioServerParameters = {
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: { ...getDefaultEnvironment(), ...spec.env },
      stderr: 'ignore',
    };
    const transport = new StdioClientTransport(server);
    const client = new Client({ name: `cat-cafe-plugin-${spec.pluginId}`, version: '0.1.0' }, { capabilities: {} });
    let settleClosed: ((result: { readonly error?: Error }) => void) | undefined;
    const closed = new Promise<{ readonly error?: Error }>((resolveClosed) => {
      settleClosed = resolveClosed;
    });
    transport.onclose = () => settleClosed?.({});
    transport.onerror = (error) => settleClosed?.({ error });
    try {
      const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
      await withTimeout(client.connect(transport), startTimeoutMs, `MCP contribution ${spec.contributionId} connect`);
      const listed = await withTimeout(
        client.listTools(),
        startTimeoutMs,
        `MCP contribution ${spec.contributionId} tools/list`,
      );
      const tools = listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: structuredClone(tool.inputSchema),
      }));
      return {
        tools,
        closed,
        callTool: (name, args) =>
          withTimeout(
            client.callTool({ name, arguments: { ...args } }),
            this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
            `MCP contribution ${spec.contributionId}/${name}`,
          ),
        close: () => closeBounded(transport),
      };
    } catch (error) {
      await closeBounded(transport).catch(() => undefined);
      throw error;
    }
  }
}

interface RunnableAuthority {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
  readonly grants: PluginGrantRecord;
}

interface ActiveContribution {
  readonly id: string;
  readonly handle: McpContributionRuntimeHandle;
}

interface ActiveExecution {
  readonly pluginId: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly materialized: MaterializedBuiltinPluginPackage;
  readonly contributions: readonly ActiveContribution[];
  available: boolean;
  cleanup?: Promise<void>;
}

function isMcpContribution(
  value: NonNullable<PluginManifest['contributions']>[number] | undefined,
): value is McpContribution {
  return value?.type === 'mcp';
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function requestedContributions(manifest: PluginManifest): readonly McpContribution[] {
  const byKey = new Map<string, NonNullable<PluginManifest['contributions']>[number]>();
  for (const contribution of manifest.contributions ?? []) {
    byKey.set(`${contribution.type}\0${contribution.id}`, contribution);
  }
  const selected: McpContribution[] = [];
  const seen = new Set<string>();
  for (const reference of manifest.features.flatMap((feature) => feature.contributions ?? [])) {
    const key = `${reference.type}\0${reference.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const contribution = byKey.get(key);
    if (!isMcpContribution(contribution)) {
      throw new BuiltinPluginContributionError(
        'UNSUPPORTED_CONTRIBUTION',
        `builtin contribution ${reference.type}/${reference.id} is not executable by this Host`,
      );
    }
    if (contribution.runtime.transport !== 'stdio') {
      throw new BuiltinPluginContributionError(
        'UNSUPPORTED_CONTRIBUTION',
        `MCP contribution ${contribution.id} does not use stdio`,
      );
    }
    selected.push(contribution);
  }
  return selected;
}

async function readContributionBinding(
  configuration: PluginContributionConfigurationPort,
  pluginInstanceId: string,
  field: ConfigurationField | undefined,
  binding: { readonly source: 'config' | 'secret'; readonly key: string },
): Promise<string | undefined> {
  const raw =
    binding.source === 'secret'
      ? await configuration.readSecret(pluginInstanceId, binding.key)
      : await configuration.readConfig(pluginInstanceId, binding.key);
  return field ? effectivePluginConfigurationValue(field, raw) : undefined;
}

export class BuiltinPluginContributionSupervisor {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly runtime: McpContributionRuntimePort;
  private readonly now: () => number;

  constructor(private readonly options: BuiltinPluginContributionSupervisorOptions) {
    this.runtime = options.runtime ?? new StdioMcpContributionRuntime();
    this.now = options.now ?? Date.now;
  }

  async start(pluginInstanceId: string): Promise<void> {
    if (this.active.has(pluginInstanceId)) {
      throw new BuiltinPluginContributionError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has active builtin contributions`,
      );
    }
    const authority = await this.runnableAuthority(pluginInstanceId);
    await this.setRuntimeState(authority, 'starting');
    let materialized: MaterializedBuiltinPluginPackage | undefined;
    const started: ActiveContribution[] = [];
    try {
      materialized = await this.options.materializer.resolve({
        pluginInstanceId,
        pluginId: authority.instance.pluginId,
        packageDigest: authority.instance.packageDigest,
        ...(authority.packageRecord.provenance?.packageName === undefined
          ? {}
          : { packageName: authority.packageRecord.provenance.packageName }),
      });
      await materialized.verifyIntegrity();
      const manifest = authority.packageRecord.manifest;
      if (manifest.runtime.transport !== 'builtin') {
        throw new BuiltinPluginContributionError(
          'INSTANCE_NOT_RUNNABLE',
          `${pluginInstanceId} is not a builtin contribution package`,
        );
      }
      for (const contribution of requestedContributions(manifest)) {
        const spec = await this.launchSpec(authority, materialized.rootDir, manifest, contribution);
        await this.assertAuthorityFence(authority, 'starting');
        started.push({ id: contribution.id, handle: await this.runtime.start(spec) });
      }
      await this.assertAuthorityFence(authority, 'starting');
      this.active.set(pluginInstanceId, {
        pluginId: authority.instance.pluginId,
        packageDigest: authority.instance.packageDigest,
        grantRevision: authority.grants.grantRevision,
        materialized,
        contributions: started,
        available: true,
      });
      await this.setRuntimeState(authority, 'healthy');
      const execution = this.active.get(pluginInstanceId);
      if (execution) this.watchContributionLiveness(pluginInstanceId, execution);
    } catch (error) {
      const cleanupOwner =
        this.active.get(pluginInstanceId) ??
        (materialized && started.length > 0
          ? {
              pluginId: authority.instance.pluginId,
              packageDigest: authority.instance.packageDigest,
              grantRevision: authority.grants.grantRevision,
              materialized,
              contributions: started,
              available: false,
            }
          : undefined);
      if (cleanupOwner) {
        cleanupOwner.available = false;
        this.active.set(pluginInstanceId, cleanupOwner);
        await this.cleanupExecution(pluginInstanceId, cleanupOwner).catch(() => undefined);
      } else {
        await materialized?.release().catch(() => undefined);
      }
      await this.setRuntimeState(authority, 'stopped').catch(() => undefined);
      throw error instanceof BuiltinPluginContributionError
        ? error
        : new BuiltinPluginContributionError('START_FAILED', 'builtin plugin contribution failed to start', {
            cause: error,
          });
    }
  }

  async stop(pluginInstanceId: string, _reason = 'host_stop'): Promise<void> {
    const execution = this.active.get(pluginInstanceId);
    if (!execution) return;
    execution.available = false;
    try {
      await this.cleanupExecution(pluginInstanceId, execution);
    } catch (error) {
      await this.projectCrashed(pluginInstanceId, execution);
      throw new BuiltinPluginContributionError('STOP_FAILED', 'builtin plugin contribution failed to stop', {
        cause: error,
      });
    }
    await this.projectStopped(pluginInstanceId, execution.packageDigest);
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    const settled = await Promise.allSettled(
      [...this.active.keys()].map((instanceId) => this.stop(instanceId, reason)),
    );
    if (settled.some((result) => result.status === 'rejected')) {
      throw new BuiltinPluginContributionError(
        'STOP_FAILED',
        'one or more builtin plugin contributions failed to stop',
      );
    }
  }

  async callTool(
    pluginInstanceId: string,
    contributionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const execution = this.active.get(pluginInstanceId);
    if (!execution?.available) {
      throw new BuiltinPluginContributionError(
        'CONTRIBUTION_NOT_ACTIVE',
        `${pluginInstanceId}/${contributionId} is not active`,
      );
    }
    const contribution = execution.contributions.find((candidate) => candidate.id === contributionId);
    if (!contribution) {
      throw new BuiltinPluginContributionError(
        'CONTRIBUTION_NOT_ACTIVE',
        `${pluginInstanceId}/${contributionId} is not active`,
      );
    }
    await this.assertLiveAuthority(pluginInstanceId, execution.packageDigest, execution.grantRevision);
    if (!contribution.handle.tools.some((tool) => tool.name === toolName)) {
      throw new BuiltinPluginContributionError(
        'CONTRIBUTION_NOT_ACTIVE',
        `${pluginInstanceId}/${contributionId} does not expose ${toolName}`,
      );
    }
    return contribution.handle.callTool(toolName, args);
  }

  async listPluginTools(pluginId: string): Promise<readonly BuiltinPluginContributionTool[]> {
    const { pluginInstanceId, execution } = this.activePluginExecution(pluginId);
    await this.assertLiveAuthority(pluginInstanceId, execution.packageDigest, execution.grantRevision);
    return execution.contributions.flatMap((contribution) =>
      contribution.handle.tools.map((tool) => ({
        contributionId: contribution.id,
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: structuredClone(tool.inputSchema),
      })),
    );
  }

  async callPluginTool(
    pluginId: string,
    contributionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const { pluginInstanceId } = this.activePluginExecution(pluginId);
    return this.callTool(pluginInstanceId, contributionId, toolName, args);
  }

  activeContributionIds(pluginInstanceId: string): readonly string[] {
    const execution = this.active.get(pluginInstanceId);
    return execution?.available ? execution.contributions.map((contribution) => contribution.id) : [];
  }

  private activePluginExecution(pluginId: string): {
    readonly pluginInstanceId: string;
    readonly execution: ActiveExecution;
  } {
    for (const [pluginInstanceId, execution] of this.active) {
      if (execution.pluginId === pluginId && execution.available) return { pluginInstanceId, execution };
    }
    throw new BuiltinPluginContributionError('CONTRIBUTION_NOT_ACTIVE', `${pluginId} is not active`);
  }

  private watchContributionLiveness(pluginInstanceId: string, execution: ActiveExecution): void {
    for (const contribution of execution.contributions) {
      if (!contribution.handle.closed) continue;
      void contribution.handle.closed.then((exit) =>
        this.handleUnexpectedClose(pluginInstanceId, execution, exit).catch(() => undefined),
      );
    }
  }

  private async handleUnexpectedClose(
    pluginInstanceId: string,
    execution: ActiveExecution,
    _exit: { readonly error?: Error },
  ): Promise<void> {
    if (!execution.available || this.active.get(pluginInstanceId) !== execution) return;
    execution.available = false;
    const projection = this.projectCrashed(pluginInstanceId, execution).catch(() => undefined);
    try {
      await this.cleanupExecution(pluginInstanceId, execution);
    } finally {
      await projection;
    }
  }

  private cleanupExecution(pluginInstanceId: string, execution: ActiveExecution): Promise<void> {
    if (execution.cleanup) return execution.cleanup;
    const cleanup = (async () => {
      const settled = await Promise.allSettled(
        [...execution.contributions].reverse().map((contribution) => contribution.handle.close()),
      );
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
      await execution.materialized.release();
      if (this.active.get(pluginInstanceId) === execution) this.active.delete(pluginInstanceId);
    })();
    execution.cleanup = cleanup;
    void cleanup.then(
      () => {
        if (execution.cleanup === cleanup) execution.cleanup = undefined;
      },
      () => {
        if (execution.cleanup === cleanup) execution.cleanup = undefined;
      },
    );
    return cleanup;
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
    const grants = instance
      ? snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId)
      : undefined;
    if (
      !instance ||
      current?.pluginInstanceId !== pluginInstanceId ||
      instance.lifecycleState !== 'installed' ||
      instance.configReadiness !== 'ready' ||
      instance.activationState !== 'enabled' ||
      !['stopped', 'crashed'].includes(instance.runtimeState) ||
      !packageRecord ||
      !grants
    ) {
      throw new BuiltinPluginContributionError('INSTANCE_NOT_RUNNABLE', `${pluginInstanceId} is not runnable`);
    }
    return { instance, packageRecord, grants };
  }

  private async launchSpec(
    authority: RunnableAuthority,
    rootDir: string,
    manifest: PluginManifest,
    contribution: McpContribution,
  ): Promise<McpContributionLaunchSpec> {
    const { rootReal, entrypoint } = await this.resolveContributionEntrypoint(rootDir, contribution);
    const env = await this.contributionEnvironment(authority, manifest, contribution);
    return {
      pluginInstanceId: authority.instance.pluginInstanceId,
      pluginId: authority.instance.pluginId,
      contributionId: contribution.id,
      command: process.execPath,
      args: [entrypoint, ...(contribution.runtime.args ?? [])],
      cwd: rootReal,
      env,
    };
  }

  private async resolveContributionEntrypoint(
    rootDir: string,
    contribution: McpContribution,
  ): Promise<{ readonly rootReal: string; readonly entrypoint: string }> {
    const rootReal = await realpath(rootDir);
    const candidate = resolve(rootReal, contribution.runtime.entrypoint);
    if (!pathInside(rootReal, candidate)) {
      throw new BuiltinPluginContributionError(
        'INVALID_ENTRYPOINT',
        `MCP contribution ${contribution.id} entrypoint must resolve inside its materialized package`,
      );
    }
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(candidate)) !== candidate) {
      throw new BuiltinPluginContributionError(
        'INVALID_ENTRYPOINT',
        `MCP contribution ${contribution.id} entrypoint must be a package-local regular file`,
      );
    }
    return { rootReal, entrypoint: candidate };
  }

  private async contributionEnvironment(
    authority: RunnableAuthority,
    manifest: PluginManifest,
    contribution: McpContribution,
  ): Promise<Readonly<Record<string, string>>> {
    const fields = new Map((manifest.configuration ?? []).map((field) => [field.key, field]));
    const effectiveGrants = new Set(authority.grants.effectiveGrants);
    const env: Record<string, string> = {};
    for (const [environmentName, binding] of Object.entries(contribution.environment ?? {})) {
      const grant = binding.source === 'secret' ? 'secret.read' : 'plugin.config.read';
      if (!effectiveGrants.has(grant)) {
        throw new BuiltinPluginContributionError(
          'CONFIG_UNAVAILABLE',
          `MCP contribution ${contribution.id} lacks Host grant ${grant}`,
        );
      }
      const field = fields.get(binding.key);
      const value = await readContributionBinding(
        this.options.configuration,
        authority.instance.pluginInstanceId,
        field,
        binding,
      );
      if (value === undefined || value.length === 0) {
        if (field?.required) {
          throw new BuiltinPluginContributionError(
            'CONFIG_UNAVAILABLE',
            `required ${binding.source} ${binding.key} is unavailable`,
          );
        }
        continue;
      }
      env[environmentName] = value;
    }
    return env;
  }

  private async assertAuthorityFence(authority: RunnableAuthority, runtimeState: RuntimeState): Promise<void> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginInstanceId === authority.instance.pluginInstanceId,
    );
    const grants = snapshot.grants.find(
      (candidate) => candidate.pluginInstanceId === authority.instance.pluginInstanceId,
    );
    if (
      !instance ||
      instance.lifecycleState !== 'installed' ||
      instance.packageDigest !== authority.instance.packageDigest ||
      instance.activationState !== 'enabled' ||
      instance.configReadiness !== 'ready' ||
      instance.runtimeState !== runtimeState ||
      grants?.grantRevision !== authority.grants.grantRevision
    ) {
      throw new BuiltinPluginContributionError(
        'INSTANCE_NOT_RUNNABLE',
        `${authority.instance.pluginInstanceId} authority changed during activation`,
      );
    }
  }

  private async assertLiveAuthority(
    pluginInstanceId: string,
    packageDigest: string,
    grantRevision: number,
  ): Promise<void> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    if (
      !instance ||
      instance.lifecycleState !== 'installed' ||
      instance.packageDigest !== packageDigest ||
      instance.activationState !== 'enabled' ||
      instance.runtimeState !== 'healthy' ||
      grants?.grantRevision !== grantRevision
    ) {
      await this.stop(pluginInstanceId, 'authority_changed').catch(() => undefined);
      throw new BuiltinPluginContributionError(
        'CONTRIBUTION_NOT_ACTIVE',
        `${pluginInstanceId} lost live contribution authority`,
      );
    }
  }

  private setRuntimeState(authority: RunnableAuthority, runtimeState: RuntimeState): Promise<void> {
    return this.options.inventory.transaction((transaction: PluginInventoryTransaction) => {
      const instance = transaction.instances.get(authority.instance.pluginInstanceId);
      if (
        !instance ||
        instance.lifecycleState !== 'installed' ||
        instance.packageDigest !== authority.instance.packageDigest ||
        instance.configReadiness !== 'ready' ||
        instance.activationState !== 'enabled'
      ) {
        throw new BuiltinPluginContributionError(
          'INSTANCE_NOT_RUNNABLE',
          `${authority.instance.pluginInstanceId} authority changed before runtime projection`,
        );
      }
      transaction.instances.put({ ...instance, runtimeState, updatedAt: this.now() });
    });
  }

  private projectStopped(pluginInstanceId: string, packageDigest: string): Promise<void> {
    return this.options.inventory.transaction((transaction) => {
      const instance = transaction.instances.get(pluginInstanceId);
      if (!instance || instance.packageDigest !== packageDigest) return;
      transaction.instances.put({ ...instance, runtimeState: 'stopped', updatedAt: this.now() });
    });
  }

  private projectCrashed(pluginInstanceId: string, execution: ActiveExecution): Promise<void> {
    return this.options.inventory.transaction((transaction) => {
      const instance = transaction.instances.get(pluginInstanceId);
      const grants = transaction.grants.get(pluginInstanceId);
      if (
        !instance ||
        instance.packageDigest !== execution.packageDigest ||
        instance.lifecycleState !== 'installed' ||
        instance.activationState !== 'enabled' ||
        instance.runtimeState !== 'healthy' ||
        grants?.grantRevision !== execution.grantRevision
      ) {
        return;
      }
      const occurredAt = this.now();
      transaction.instances.put({
        ...instance,
        activationState: 'error',
        runtimeState: 'crashed',
        lifecycleRevision: instance.lifecycleRevision + 1,
        updatedAt: occurredAt,
        lastRuntimeError: {
          code: 'UNEXPECTED_RUNTIME_FAILURE',
          exitCode: null,
          signal: null,
          occurredAt,
        },
      });
    });
  }
}
