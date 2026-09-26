import { isDeepStrictEqual } from 'node:util';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  DirectToolContribution,
  LimbContribution,
  ScheduleContribution,
  WebhookContribution,
} from '@clowder-ai/plugin-contract';
import type { TaskSpec_P1 } from '../../../infrastructure/scheduler/types.js';
import { LimbRegistry } from '../../limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../../limb/limb-yaml-loader.js';
import { type InvokeContext, PluginLimbAdapter } from '../../limb/PluginLimbAdapter.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { ExternalPluginRuntimeError, type VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import { effectivePluginConfigurationValue } from '../manager/plugin-configuration-values.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';
import { resolvePackageFile } from './declared-resource-paths.js';
import { type DeclaredPluginWebhook, validateDeclaredWebhooks } from './declared-webhooks.js';

export type { DeclaredPluginWebhook } from './declared-webhooks.js';

export interface DeclaredScheduleTaskRunner {
  registerPostStart(task: TaskSpec_P1): void;
  unregister(taskId: string): boolean;
}

export interface DeclaredRuntimeContributionHost {
  readonly packages: VerifiedPluginPackageLocator;
  readonly limbRegistry?: LimbRegistry;
  readonly taskRunner?: DeclaredScheduleTaskRunner;
  readonly configuration: PluginRuntimeConfigurationPort;
  readonly redis?: RedisClient;
}

interface ActiveRuntimeContributions {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly limbNodeIds: readonly string[];
  readonly scheduleTaskIds: readonly string[];
  readonly tools: readonly DirectToolContribution[];
  readonly webhooks: readonly WebhookContribution[];
  readonly invoke: InvokePluginAction;
}

type InvokePluginAction = (pluginInstanceId: string, method: string, params: unknown) => Promise<unknown>;

export interface DeclaredPluginTool {
  readonly contributionId: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
    readonly $schema?: string;
  };
}

export type DeclaredPluginToolCall = { readonly handled: false } | { readonly handled: true; readonly value: unknown };

/**
 * Runtime-only declarations live exactly as long as the package activation. Static resources
 * (skill/MCP) deliberately live outside this registry because Host shutdown must not remove them.
 */
export class DeclaredRuntimeContributions {
  readonly #active = new Map<string, ActiveRuntimeContributions>();

  constructor(private readonly host: DeclaredRuntimeContributionHost) {}

  async activate(admission: PluginRuntimeAdmission, invoke: InvokePluginAction): Promise<void> {
    const pluginInstanceId = admission.instance.pluginInstanceId;
    if (this.#active.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has declared runtime contributions`,
      );
    }
    const contributions = admission.packageRecord.manifest.contributions ?? [];
    const limbs = contributions.filter((value): value is LimbContribution => value.type === 'limb');
    const schedules = contributions.filter((value): value is ScheduleContribution => value.type === 'schedule');
    const tools = contributions.filter((value): value is DirectToolContribution => value.type === 'tool');
    const webhooks = contributions.filter((value): value is WebhookContribution => value.type === 'webhook');
    if (limbs.length === 0 && schedules.length === 0 && tools.length === 0 && webhooks.length === 0) return;
    if (limbs.length > 0 && !this.host.limbRegistry) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host limb registry is unavailable');
    }
    const limbNodeIds: string[] = [];
    const scheduleTaskIds: string[] = [];
    try {
      if (schedules.length > 0 && !admission.effectiveGrants.includes('schedule.register')) {
        throw new ExternalPluginRuntimeError(
          'DELIVERY_REJECTED',
          `${admission.packageRecord.pluginId} lacks schedule.register`,
        );
      }
      if (schedules.length > 0 && !this.host.taskRunner) {
        throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host task runner is unavailable');
      }
      for (const tool of tools) directToolSchema(tool);
      validateDeclaredWebhooks(webhooks);
      if (limbs.length > 0) {
        await this.#activateLimbs(admission, limbs, limbNodeIds, invoke);
      }
      for (const contribution of schedules) {
        const task = scheduleTask(admission, contribution, invoke);
        this.host.taskRunner?.registerPostStart(task);
        scheduleTaskIds.push(task.id);
      }
      this.#active.set(pluginInstanceId, {
        pluginId: admission.packageRecord.pluginId,
        pluginInstanceId,
        limbNodeIds,
        scheduleTaskIds,
        tools,
        webhooks,
        invoke,
      });
    } catch (error) {
      this.#remove({ limbNodeIds, scheduleTaskIds });
      throw error;
    }
  }

  deactivate(pluginInstanceId: string): void {
    const active = this.#active.get(pluginInstanceId);
    if (!active) return;
    this.#active.delete(pluginInstanceId);
    this.#remove(active);
  }

  deactivateAll(): void {
    for (const pluginInstanceId of [...this.#active.keys()]) this.deactivate(pluginInstanceId);
  }

  listPluginTools(pluginId: string): readonly DeclaredPluginTool[] | undefined {
    const active = this.#activeForPlugin(pluginId);
    if (!active || active.tools.length === 0) return undefined;
    return active.tools.map((tool) => ({
      contributionId: tool.id,
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: structuredClone(directToolSchema(tool)),
    }));
  }

  async callPluginTool(
    pluginId: string,
    contributionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<DeclaredPluginToolCall> {
    const active = this.#activeForPlugin(pluginId);
    if (!active || active.tools.length === 0) return { handled: false };
    const tool = active.tools.find((candidate) => candidate.id === contributionId && candidate.name === toolName);
    if (!tool) {
      throw new ExternalPluginRuntimeError(
        'DELIVERY_REJECTED',
        `${pluginId}/${contributionId}/${toolName} is not active`,
      );
    }
    return {
      handled: true,
      value: await active.invoke(active.pluginInstanceId, tool.action.method, {
        ...args,
        ...(tool.action.params ?? {}),
      }),
    };
  }

  resolvePluginWebhook(pluginId: string, path: string): DeclaredPluginWebhook | undefined {
    const contribution = this.#activeForPlugin(pluginId)?.webhooks.find((candidate) => candidate.path === path);
    if (!contribution) return undefined;
    return {
      contributionId: contribution.id,
      path: contribution.path,
      methods: contribution.methods,
      anonymous: contribution.verificationSecretRef !== undefined,
    };
  }

  async callPluginWebhook(
    pluginId: string,
    contributionId: string,
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const active = this.#activeForPlugin(pluginId);
    const contribution = active?.webhooks.find((candidate) => candidate.id === contributionId);
    if (!active || !contribution) {
      throw new ExternalPluginRuntimeError(
        'DELIVERY_REJECTED',
        `${pluginId}/${contributionId} is not an active webhook`,
      );
    }
    return active.invoke(active.pluginInstanceId, contribution.action.method, {
      ...(contribution.action.params ?? {}),
      request,
    });
  }

  #activeForPlugin(pluginId: string): ActiveRuntimeContributions | undefined {
    for (const active of this.#active.values()) {
      if (active.pluginId === pluginId) return active;
    }
    return undefined;
  }

  async #activateLimbs(
    admission: PluginRuntimeAdmission,
    limbs: readonly LimbContribution[],
    registered: string[],
    invoke: InvokePluginAction,
  ): Promise<void> {
    const located = await this.host.packages.resolveInstalledPackage(admission.packageRecord.packageDigest);
    try {
      if (!isDeepStrictEqual(located.manifest, admission.packageRecord.manifest)) {
        throw new ExternalPluginRuntimeError(
          'PACKAGE_AUTHORITY_MISMATCH',
          'located package manifest differs from the admitted package record',
        );
      }
      await located.verifyIntegrity();
      const pluginConfig = await configurationSnapshot(admission, this.host.configuration);
      for (const contribution of limbs) {
        const manifestPath = await resolvePackageFile(located.rootDir, contribution.manifestPath, 'Limb manifest');
        const declaration = loadLimbDeclaration(manifestPath);
        const handlers = Object.fromEntries(
          Object.values(declaration.commands)
            .map((command) => command.handler)
            .filter((handler): handler is string => Boolean(handler) && handler !== 'builtin:health_check')
            .map((handler) => [
              handler,
              async (params: Record<string, unknown>, ctx: InvokeContext) =>
                limbResult(
                  await invoke(admission.instance.pluginInstanceId, handler, {
                    params,
                    ...(ctx.invocation === undefined ? {} : { invocation: ctx.invocation }),
                  }),
                  handler,
                ),
            ]),
        );
        const node = new PluginLimbAdapter({
          declaration,
          pluginConfig,
          handlers,
          ...(this.host.redis === undefined ? {} : { redis: this.host.redis }),
        });
        await this.host.limbRegistry?.register(node);
        registered.push(node.nodeId);
      }
    } finally {
      await located.release();
    }
  }

  #remove(active: Pick<ActiveRuntimeContributions, 'limbNodeIds' | 'scheduleTaskIds'>): void {
    for (const taskId of [...active.scheduleTaskIds].reverse()) this.host.taskRunner?.unregister(taskId);
    for (const nodeId of [...active.limbNodeIds].reverse()) this.host.limbRegistry?.deregister(nodeId);
  }
}

function directToolSchema(tool: DirectToolContribution): DeclaredPluginTool['inputSchema'] {
  const schema = tool.inputSchema;
  if (schema.type !== 'object') {
    throw new ExternalPluginRuntimeError(
      'PROTOCOL_VIOLATION',
      `Tool contribution ${tool.id} must declare an object input schema`,
    );
  }
  return schema as DeclaredPluginTool['inputSchema'];
}

async function configurationSnapshot(
  admission: PluginRuntimeAdmission,
  configuration: PluginRuntimeConfigurationPort,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of admission.packageRecord.manifest.configuration ?? []) {
    const grant = field.kind === 'secret' ? 'secret.read' : 'plugin.config.read';
    if (!admission.effectiveGrants.includes(grant)) continue;
    const raw =
      field.kind === 'secret'
        ? await configuration.readSecret(admission.instance.pluginInstanceId, field.key)
        : await configuration.readConfig(admission.instance.pluginInstanceId, field.key);
    const value = effectivePluginConfigurationValue(field, raw);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

function limbResult(value: unknown, method: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as { success?: unknown }).success !== 'boolean'
  ) {
    throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `Limb action ${method} returned an invalid result`);
  }
  return value as { success: boolean; data?: unknown; error?: string; artifactUri?: string };
}

function scheduleTask(
  admission: PluginRuntimeAdmission,
  contribution: ScheduleContribution,
  invoke: InvokePluginAction,
): TaskSpec_P1 {
  const taskId = `plugin:${admission.packageRecord.pluginId}:schedule:${contribution.id}`;
  const params = contribution.action.params ?? {};
  return {
    id: taskId,
    profile: 'poller',
    trigger:
      contribution.schedule.kind === 'interval'
        ? { type: 'interval', ms: contribution.schedule.everyMs }
        : { type: 'cron', expression: contribution.schedule.expression },
    admission: {
      gate: async () => ({
        run: true,
        workItems: [{ signal: structuredClone(params), subjectKey: contribution.id }],
      }),
    },
    run: {
      overlap: contribution.policy.overlap,
      timeoutMs: contribution.policy.timeoutMs,
      execute: async (signal) => {
        await invoke(admission.instance.pluginInstanceId, contribution.action.method, signal);
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  };
}
