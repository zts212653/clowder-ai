import {
  type ConfigurationField,
  type OperationActionResult,
  type PluginManifest,
  type PluginTestResult,
  validateOperationRowsResult,
} from '@clowder-ai/plugin-contract';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { pluginAccessError, requirePluginOwnerLocalAccess } from '../../../routes/plugin-access-guards.js';
import type { PluginSettingsInvocation } from '../builtin-runtime/carriers/module-plugin-settings.js';
import type { HostPluginInvocationPort } from '../carrier/host-invocation.js';
import { withoutPluginCallContext } from '../carrier/plugin-call-context.js';
import {
  currentOwnerOperationRequest,
  type OwnerOperationRequest,
  PluginOwnerOperationExpiredError,
  withOwnerOperationInvocation,
  withOwnerOperationRequest,
} from '../carrier/plugin-owner-operation-context.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { assertExecutablePackage } from '../host-inventory/stored-manifest.js';
import type { ExecutablePluginPackageRecord, PluginInstanceRecord } from '../host-inventory/types.js';
import type { PersonalChromeSetup } from '../manager/chrome-setup/personal-chrome-setup.js';
import { isChromeSetupRequest } from '../manager/chrome-setup/personal-chrome-setup-policy.js';
import { type OperationState, transitionOperationState } from './operation-state-machine.js';
import { expiredOperation, type PluginOperationCommitFence } from './plugin-operation-fence.js';

const DEFAULT_TIMEOUT_MS = 30_000;
class PluginSettingsUnavailableError extends Error {}
type OperationField = Extract<ConfigurationField, { readonly kind: 'operation' }>;

export interface PluginOperationConfigurationPort {
  completeOperation?(pluginId: string, pluginInstanceId: string, expectedRevision: number): Promise<void>;
  readActionInput(pluginId: string): Promise<Readonly<Record<string, unknown>>>;
  readOperationState(pluginId: string, operationKey: string): Promise<OperationState | undefined>;
  writeOperationState(
    pluginId: string,
    operationKey: string,
    state: OperationState,
    fence?: PluginOperationCommitFence,
  ): Promise<void>;
  clearOperationState(pluginId: string, operationKey: string): Promise<void>;
  configureOperationTargets(
    pluginId: string,
    pluginInstanceId: string,
    operationKey: string,
    values: Readonly<Record<string, string>>,
    fence?: PluginOperationCommitFence,
  ): Promise<readonly string[]>;
}

export interface InstalledPluginOperationsOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly configuration: PluginOperationConfigurationPort;
  readonly invocation: Pick<HostPluginInvocationPort, 'invoke'>;
  readonly settingsInvocation?: PluginSettingsInvocation;
  readonly personalChromeSetup?: PersonalChromeSetup;
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
  readonly packageRecord: ExecutablePluginPackageRecord;
  readonly grantRevision: number | undefined;
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

/**
 * F202 W2-3 h1 ③: a `rows` result is validated with the contract's own validator against the
 * declaring operation. An undeclared or non-row action reference, a duplicate key or any schema
 * violation invalidates the whole result (fail-closed), so runtime data can never introduce a method.
 */
function rowsChecked(
  declaredOperation: OperationField,
  result: OperationActionResult | undefined,
): OperationActionResult | undefined {
  if (!result || result.render !== 'rows') return result;
  // The validator takes the rows payload itself (`data`), whatever its doc comment suggests.
  const rows = validateOperationRowsResult(declaredOperation, result.data);
  return rows.valid ? { ...result, data: rows.value } : undefined;
}

/**
 * Rejects an action input the Host cannot pass on. A row action is invoked from one row of a `rows`
 * result, so it needs that row's input (F202 W2-3 h1 ④).
 */
function actionInputRejection(
  action: OperationField['actions'][number],
  body: unknown,
): InstalledPluginOperationResult | undefined {
  if (body !== undefined && body !== null && !jsonRecord(body)) {
    return response(400, { error: 'Operation action input must be a JSON object' });
  }
  if (action.render === 'row' && (!jsonRecord(body) || Object.keys(body).length === 0)) {
    return response(400, { error: `Row action '${action.id}' needs the input of the row it acts on` });
  }
  return undefined;
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, abort?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort?.();
          reject(new PluginInvocationTimeoutError());
        }, timeoutMs);
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
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
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
    if (!packageRecord.manifest)
      return response(409, { error: 'Plugin version is incompatible; update or reinstall it' });
    assertExecutablePackage(packageRecord);
    if (
      !this.options.settingsInvocation &&
      (instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
    ) {
      return response(409, { error: `Plugin '${pluginId}' is not enabled` });
    }
    return {
      instance,
      packageRecord,
      grantRevision: snapshot.grants.find((grant) => grant.pluginInstanceId === instance.pluginInstanceId)
        ?.grantRevision,
    };
  }

  async runAction(
    pluginId: string,
    operationKey: string,
    actionId: string,
    body: unknown,
  ): Promise<InstalledPluginOperationResult> {
    const seed = currentOwnerOperationRequest();
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(seed ? [seed.signal] : [])]);
    const assertRequestCurrent = () => {
      if (signal.aborted) expiredOperation();
      seed?.assertCurrent();
      if (seed && (seed.pluginId !== pluginId || seed.operationKey !== operationKey || seed.actionId !== actionId))
        expiredOperation();
    };
    const request = seed ? { ...seed, signal, assertCurrent: assertRequestCurrent } : undefined;
    try {
      assertRequestCurrent();
      if (isChromeSetupRequest(pluginId, operationKey)) {
        if (!request || !this.options.personalChromeSetup)
          return response(403, { error: 'Host setup requires a local owner request' });
        return await withOwnerOperationRequest(request, () =>
          this.options.personalChromeSetup!.runAction(actionId, body),
        );
      }
      return await withTimeout(
        this.executeAction(pluginId, operationKey, actionId, body, assertRequestCurrent, request),
        this.timeoutMs,
        () => lifetime.abort(),
      );
    } catch (error) {
      if (error instanceof PluginSettingsUnavailableError) return response(409, { error: error.message });
      if (error instanceof PluginInvocationTimeoutError) return response(504, { error: 'Plugin operation timed out' });
      if (error instanceof PluginOwnerOperationExpiredError) return response(409, { error: error.message });
      return response(502, { error: `Action failed: ${safeActionErrorMessage(error)}` });
    } finally {
      lifetime.abort();
    }
  }

  private async executeAction(
    pluginId: string,
    operationKey: string,
    actionId: string,
    body: unknown,
    assertRequestCurrent: () => void,
    request?: OwnerOperationRequest,
  ): Promise<InstalledPluginOperationResult> {
    const active = await this.resolve(pluginId);
    if ('status' in active) return active;
    if (
      request &&
      (active.packageRecord.manifest.runtime?.transport !== 'builtin' ||
        typeof active.packageRecord.manifest.runtime.entrypoint !== 'string')
    )
      return response(409, { error: 'Owner operation requires the module carrier' });
    const declaredOperation = operation(active.packageRecord.manifest, operationKey);
    if (!declaredOperation) return response(404, { error: `Operation '${operationKey}' is not declared` });
    const action = declaredOperation.actions.find((candidate) => candidate.id === actionId);
    if (!action) return response(404, { error: `Action '${actionId}' is not declared` });
    if (action.confirm !== undefined && request?.confirmed !== true)
      return response(400, { error: 'Confirm this operation first' });
    const declaration = JSON.stringify(declaredOperation);
    const fence: PluginOperationCommitFence = {
      assertRequestCurrent,
      assertRecords: (instance, record, grant) => {
        assertRequestCurrent();
        if (
          !instance ||
          !record ||
          record.manifest === null ||
          instance.pluginInstanceId !== active.instance.pluginInstanceId ||
          instance.packageDigest !== active.instance.packageDigest ||
          instance.lifecycleRevision !== active.instance.lifecycleRevision ||
          instance.lifecycleState !== 'installed' ||
          instance.activationState !== active.instance.activationState ||
          instance.runtimeState !== active.instance.runtimeState ||
          grant?.grantRevision !== active.grantRevision ||
          record.packageDigest !== active.packageRecord.packageDigest ||
          JSON.stringify(operation(record.manifest, operationKey)) !== declaration
        )
          expiredOperation();
      },
    };
    const assertCurrent = async () => {
      assertRequestCurrent();
      const snapshot = await this.options.inventory.snapshot();
      const instance = snapshot.instances.find(
        (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
      );
      fence.assertRecords(
        instance,
        snapshot.packages.find((candidate) => candidate.packageDigest === instance?.packageDigest),
        snapshot.grants.find((candidate) => candidate.pluginInstanceId === instance?.pluginInstanceId),
      );
    };
    const rejected = actionInputRejection(action, body);
    if (rejected) return rejected;

    const currentValues = await this.options.configuration.readActionInput(pluginId);
    const input = { ...currentValues, ...((body ?? {}) as Readonly<Record<string, unknown>>) };
    await assertCurrent();
    const currentState = await this.options.configuration.readOperationState(pluginId, operationKey);
    const params = {
      ...(action.action.params ?? {}),
      input,
      ...(currentState
        ? {
            operationState: {
              currentAction: currentState.currentAction,
              ...(currentState.updatedAt === undefined ? {} : { updatedAt: currentState.updatedAt }),
            },
          }
        : {}),
    };
    const invoke = async () => {
      const result = await this.options.settingsInvocation?.({
        pluginInstanceId: active.instance.pluginInstanceId,
        packageRecord: active.packageRecord,
        effectiveGrants:
          (await this.options.inventory.snapshot()).grants.find(
            (grant) => grant.pluginInstanceId === active.instance.pluginInstanceId,
          )?.effectiveGrants ?? [],
        method: action.action.method,
        params,
        assertCurrent,
      });
      if (result?.handled) return result.result;
      if (active.instance.activationState !== 'enabled' || active.instance.runtimeState !== 'healthy')
        throw new PluginSettingsUnavailableError('Plugin has no loaded settings handler');
      return this.options.invocation.invoke(active.instance.pluginInstanceId, action.action.method, params);
    };
    const rawResult = await (request
      ? withOwnerOperationInvocation(
          request,
          active.instance.pluginInstanceId,
          action.action.method,
          assertCurrent,
          invoke,
        )
      : invoke());
    await assertCurrent();
    const result = rowsChecked(declaredOperation, operationResult(rawResult));
    if (!result) return response(502, { error: 'Plugin operation returned an invalid response' });

    await assertCurrent();
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
            fence,
          );
    await assertCurrent();
    await this.options.configuration.writeOperationState(pluginId, operationKey, transition.state, fence);
    if (backfilledKeys.length)
      await this.options.configuration.completeOperation?.(
        pluginId,
        active.instance.pluginInstanceId,
        active.instance.lifecycleRevision,
      );
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
    const controller = new AbortController();
    let rawResult: unknown;
    try {
      const assertCurrent = async () => {
        if (controller.signal.aborted) expiredOperation();
        const fresh = await this.resolve(pluginId);
        if (
          'status' in fresh ||
          fresh.instance.pluginInstanceId !== active.instance.pluginInstanceId ||
          fresh.instance.packageDigest !== active.instance.packageDigest ||
          fresh.instance.lifecycleRevision !== active.instance.lifecycleRevision ||
          fresh.grantRevision !== active.grantRevision
        )
          expiredOperation();
      };
      const invoke = async () => {
        const params = {
          ...(declared.action.params ?? {}),
          input: await this.options.configuration.readActionInput(pluginId),
        };
        const result = await this.options.settingsInvocation?.({
          pluginInstanceId: active.instance.pluginInstanceId,
          packageRecord: active.packageRecord,
          effectiveGrants:
            (await this.options.inventory.snapshot()).grants.find(
              (grant) => grant.pluginInstanceId === active.instance.pluginInstanceId,
            )?.effectiveGrants ?? [],
          method: declared.action.method,
          params,
          assertCurrent,
        });
        if (result?.handled) return result.result;
        if (active.instance.activationState !== 'enabled' || active.instance.runtimeState !== 'healthy')
          throw new PluginSettingsUnavailableError('Plugin has no loaded test handler');
        return this.options.invocation.invoke(
          active.instance.pluginInstanceId,
          declared.action.method,
          declared.action.params ?? {},
        );
      };
      rawResult = await withTimeout(invoke(), this.timeoutMs, () => controller.abort());
      await assertCurrent();
    } catch (error) {
      if (error instanceof PluginSettingsUnavailableError) return response(409, { error: error.message });
      if (error instanceof PluginOwnerOperationExpiredError) return response(409, { error: error.message });
      if (error instanceof PluginInvocationTimeoutError) return response(504, { error: 'Plugin test timed out' });
      return response(502, { error: 'Plugin test invocation failed' });
    } finally {
      controller.abort();
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
  app.post<{ Params: { pluginId: string } }>('/api/plugins/:pluginId/test', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    return sendInstalledPluginTestResult(reply, await options.operations.runTest(request.params.pluginId));
  });

  app.post<{ Params: { pluginId: string; operation: string; action: string } }>(
    '/api/plugins/:pluginId/actions/:operation/:action',
    async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, 'write');
      if ('error' in access) return pluginAccessError(reply, access);
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      const activationChecks: (() => void)[] = [];
      const activationSignals: AbortSignal[] = [];
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      if (request.raw.aborted || reply.raw.destroyed) abort();
      const seed: OwnerOperationRequest = {
        confirmed: request.headers['x-cat-cafe-owner-confirmed'] === 'true',
        pluginId: request.params.pluginId,
        operationKey: request.params.operation,
        actionId: request.params.action,
        userId: access.operator,
        requestId: request.id,
        signal: cancellation.signal,
        assertCurrent: () => {
          if (cancellation.signal.aborted) expiredOperation();
          for (const check of activationChecks) check();
          try {
            request.assertSessionCurrent?.();
          } catch {
            expiredOperation();
          }
          const latest = requirePluginOwnerLocalAccess(request, 'write');
          if ('error' in latest || latest.operator !== access.operator) expiredOperation();
        },
        bindActivation: (check, signal) => {
          activationChecks.push(check);
          if (signal) {
            activationSignals.push(signal);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }
        },
      };
      let result: InstalledPluginOperationResult;
      try {
        result = await withoutPluginCallContext(() =>
          withOwnerOperationRequest(seed, () =>
            options.operations.runAction(
              request.params.pluginId,
              request.params.operation,
              request.params.action,
              request.body,
            ),
          ),
        );
      } finally {
        abort();
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
        for (const signal of activationSignals) signal.removeEventListener('abort', abort);
      }
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
