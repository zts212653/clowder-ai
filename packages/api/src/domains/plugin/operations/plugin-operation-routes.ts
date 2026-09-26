import type {
  ConfigurationField,
  OperationActionResult,
  PluginManifest,
  PluginTestResult,
} from '@clowder-ai/plugin-contract';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { pluginAccessError, requirePluginOwnerLocalAccess } from '../../../routes/plugin-access-guards.js';
import type { HostPluginInvocationPort } from '../carrier/host-invocation.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { type OperationState, transitionOperationState } from './operation-state-machine.js';

const DEFAULT_TIMEOUT_MS = 30_000;
type OperationField = Extract<ConfigurationField, { readonly kind: 'operation' }>;

export interface PluginOperationConfigurationPort {
  readActionInput(pluginId: string): Promise<Readonly<Record<string, unknown>>>;
  readOperationState(pluginId: string, operationKey: string): Promise<OperationState | undefined>;
  writeOperationState(pluginId: string, operationKey: string, state: OperationState): Promise<void>;
  clearOperationState(pluginId: string, operationKey: string): Promise<void>;
  configureOperationTargets(
    pluginId: string,
    pluginInstanceId: string,
    operationKey: string,
    values: Readonly<Record<string, string>>,
  ): Promise<readonly string[]>;
}

export interface InstalledPluginOperationsOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly configuration: PluginOperationConfigurationPort;
  readonly invocation: Pick<HostPluginInvocationPort, 'invoke'>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface InstalledPluginOperationResult {
  readonly matched: boolean;
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface ActivePlugin {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
}

function response(
  status: number,
  body: Readonly<Record<string, unknown>>,
  matched = true,
): InstalledPluginOperationResult {
  return { matched, status, body };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return false;
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function operationResult(value: unknown): OperationActionResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowed = new Set(['render', 'data', 'label', 'targetValues', 'advance', 'activate']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (typeof value.render !== 'string' || value.render.length === 0 || !Object.hasOwn(value, 'data')) return undefined;
  if (value.label !== undefined && typeof value.label !== 'string') return undefined;
  if (value.advance !== undefined && typeof value.advance !== 'boolean') return undefined;
  if (value.activate !== undefined && typeof value.activate !== 'boolean') return undefined;
  if (value.targetValues !== undefined) {
    if (!isPlainRecord(value.targetValues)) return undefined;
    if (Object.values(value.targetValues).some((item) => typeof item !== 'string')) return undefined;
  }
  try {
    structuredClone(value.data);
  } catch {
    return undefined;
  }
  return structuredClone(value) as OperationActionResult;
}

function testResult(value: unknown): PluginTestResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowed = new Set(['ok', 'message', 'details']);
  if (Object.keys(value).some((key) => !allowed.has(key)) || typeof value.ok !== 'boolean') return undefined;
  if (value.message !== undefined && typeof value.message !== 'string') return undefined;
  if (value.details !== undefined && !jsonRecord(value.details)) return undefined;
  return structuredClone(value) as PluginTestResult;
}

function operation(manifest: PluginManifest, key: string): OperationField | undefined {
  return (manifest.configuration ?? []).find(
    (field): field is OperationField => field.kind === 'operation' && field.key === key,
  );
}

class PluginInvocationTimeoutError extends Error {}

function safeActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const firstLine = message.split(/[\r\n]/, 1)[0] ?? '';
  const printable = Array.from(firstLine)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return printable ? Array.from(printable).slice(0, 200).join('') : 'Plugin operation invocation failed';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PluginInvocationTimeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class InstalledPluginOperations {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: InstalledPluginOperationsOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  private async resolve(pluginId: string): Promise<InstalledPluginOperationResult | ActivePlugin> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance) return response(404, { error: `Plugin '${pluginId}' is not installed` }, false);
    const packageRecord = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    if (!packageRecord) return response(404, { error: `Plugin '${pluginId}' package is unavailable` });
    if (instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') {
      return response(409, { error: `Plugin '${pluginId}' is not enabled` });
    }
    return { instance, packageRecord };
  }

  async runAction(
    pluginId: string,
    operationKey: string,
    actionId: string,
    body: unknown,
  ): Promise<InstalledPluginOperationResult> {
    const active = await this.resolve(pluginId);
    if ('status' in active) return active;
    const declaredOperation = operation(active.packageRecord.manifest, operationKey);
    if (!declaredOperation) return response(404, { error: `Operation '${operationKey}' is not declared` });
    const action = declaredOperation.actions.find((candidate) => candidate.id === actionId);
    if (!action) return response(404, { error: `Action '${actionId}' is not declared` });
    if (body !== undefined && body !== null && !jsonRecord(body)) {
      return response(400, { error: 'Operation action input must be a JSON object' });
    }

    const currentValues = await this.options.configuration.readActionInput(pluginId);
    const input = { ...currentValues, ...((body ?? {}) as Readonly<Record<string, unknown>>) };
    let rawResult: unknown;
    try {
      rawResult = await withTimeout(
        this.options.invocation.invoke(active.instance.pluginInstanceId, action.action.method, {
          ...(action.action.params ?? {}),
          input,
        }),
        this.timeoutMs,
      );
    } catch (error) {
      if (error instanceof PluginInvocationTimeoutError) {
        return response(504, { error: 'Plugin operation timed out' });
      }
      return response(502, { error: `Action failed: ${safeActionErrorMessage(error)}` });
    }
    const result = operationResult(rawResult);
    if (!result) return response(502, { error: 'Plugin operation returned an invalid response' });

    const currentState = await this.options.configuration.readOperationState(pluginId, operationKey);
    const transition = transitionOperationState({
      actions: declaredOperation.actions,
      actionId,
      currentState,
      targetKeys: declaredOperation.target,
      result,
      now: this.now(),
    });
    const backfilledKeys =
      Object.keys(transition.targetValues).length === 0
        ? []
        : await this.options.configuration.configureOperationTargets(
            pluginId,
            active.instance.pluginInstanceId,
            operationKey,
            transition.targetValues,
          );
    await this.options.configuration.writeOperationState(pluginId, operationKey, transition.state);
    return response(200, {
      ok: true,
      render: result.render,
      data: result.data,
      ...(result.label === undefined ? {} : { label: result.label }),
      currentAction: transition.state.currentAction,
      advance: transition.decision.kind === 'next',
      ...(transition.decision.kind === 'rollback' ? { transition: 'rollback' } : {}),
      ...(backfilledKeys.length === 0 ? {} : { backfilledKeys: [...backfilledKeys] }),
      ...(result.activate === undefined ? {} : { activate: result.activate }),
    });
  }

  async reset(pluginId: string, operationKey: string): Promise<InstalledPluginOperationResult> {
    const active = await this.resolve(pluginId);
    if ('status' in active) return active;
    if (!operation(active.packageRecord.manifest, operationKey)) {
      return response(404, { error: `Operation '${operationKey}' is not declared` });
    }
    await this.options.configuration.clearOperationState(pluginId, operationKey);
    return response(200, { ok: true });
  }

  async runTest(pluginId: string): Promise<InstalledPluginOperationResult> {
    const active = await this.resolve(pluginId);
    if ('status' in active) return active;
    const declared = active.packageRecord.manifest.test;
    if (!declared) return response(400, { error: `Plugin '${pluginId}' does not declare a test action` });
    let rawResult: unknown;
    try {
      rawResult = await withTimeout(
        this.options.invocation.invoke(
          active.instance.pluginInstanceId,
          declared.action.method,
          declared.action.params ?? {},
        ),
        this.timeoutMs,
      );
    } catch (error) {
      if (error instanceof PluginInvocationTimeoutError) return response(504, { error: 'Plugin test timed out' });
      return response(502, { error: 'Plugin test invocation failed' });
    }
    const result = testResult(rawResult);
    return result ? response(200, result) : response(502, { error: 'Plugin test returned an invalid response' });
  }
}

export function sendInstalledPluginTestResult(reply: FastifyReply, result: InstalledPluginOperationResult): unknown {
  return reply.status(result.status).send(result.body);
}

export interface PluginOperationRoutesOptions {
  readonly operations: InstalledPluginOperations;
}

/** Fixed Host routes for package-declared operation actions and state reset. */
export const pluginOperationRoutes: FastifyPluginAsync<PluginOperationRoutesOptions> = async (app, options) => {
  app.post<{ Params: { pluginId: string; operation: string; action: string } }>(
    '/api/plugins/:pluginId/actions/:operation/:action',
    async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, 'write');
      if ('error' in access) return pluginAccessError(reply, access);
      const result = await options.operations.runAction(
        request.params.pluginId,
        request.params.operation,
        request.params.action,
        request.body,
      );
      if (result.status === 502) {
        request.log.warn(
          { pluginId: request.params.pluginId, operation: request.params.operation, action: request.params.action },
          'Plugin operation action failed',
        );
      }
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: { pluginId: string; operation: string } }>(
    '/api/plugins/:pluginId/operations/:operation/reset',
    async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, 'write');
      if ('error' in access) return pluginAccessError(reply, access);
      const result = await options.operations.reset(request.params.pluginId, request.params.operation);
      return reply.status(result.status).send(result.body);
    },
  );
};
