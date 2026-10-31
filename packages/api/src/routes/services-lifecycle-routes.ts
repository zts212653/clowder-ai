import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { getServiceConfig, setServiceConfig } from '../domains/services/service-config.js';
import {
  appendServiceLog,
  findPidsByPort,
  isPrimaryServiceProcess,
  isServiceProcessCommand,
  listProcesses,
  type ProcessSnapshot,
  readProcessCommand,
  readServiceLogTail,
  resolveServiceScriptPath,
  runServiceScript,
  type ServiceLifecycleAction,
  type ServiceLifecycleRunner,
  waitForPortBindable,
} from '../domains/services/service-lifecycle.js';
import {
  type FetchServiceHealth,
  fetchServiceHealth,
  getServiceManifest,
  resolveEffectiveServiceConfig,
  resolveServiceEndpoint,
  resolveServiceHealthUrl,
  SERVICE_MANIFESTS,
  type ServiceConfig,
  type ServiceManifest,
  serviceHealthIdentityMatches,
} from '../domains/services/service-manifest.js';
import { createProcessTerminator } from '../domains/services/service-process-termination.js';
import {
  registerServiceLifecycleAuditRoutes,
  SERVICE_LIFECYCLE_AUDIT_TYPE,
  type ServiceLifecycleAuditLog,
} from './services-lifecycle-audit-routes.js';
import {
  buildLifecycleEnv,
  DEFAULT_LIFECYCLE_TIMEOUT_MS,
  getLifecycleRunSettlement,
  lifecycleFailureStatus,
  lifecycleOwnerError,
  requireLifecycleOwner,
  runWithTimeout,
} from './services-lifecycle-helpers.js';
import { createServiceLifecycleLock, holdLifecycleLockUntil, holdStartupGrace } from './services-lifecycle-lock.js';
import {
  createServicePortPartitioner,
  resolveSuggestedServicePort,
  servicePortProbeUnavailableError,
} from './services-lifecycle-port.js';

export interface ServiceLifecycleRouteOptions {
  runScript?: ServiceLifecycleRunner;
  timeoutMs?: number;
  startupGraceMs?: number;
  startupReadinessTimeoutMs?: number;
  startupProbeIntervalMs?: number;
  autoStartEnabled?: boolean;
  onServiceReady?: (event: {
    service: ServiceManifest;
    operator: string;
    reason: 'already-running' | 'readiness';
  }) => void | Promise<void>;
  onServiceUnavailable?: (event: {
    service: ServiceManifest;
    operator: string;
    reason: 'stop' | 'uninstall' | 'disabled';
  }) => void | Promise<void>;
  findPidsByPort?: (port: number) => Promise<number[]>;
  listProcesses?: () => Promise<ProcessSnapshot[]>;
  readProcessCommand?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  shutdownGraceMs?: number;
  shutdownKillGraceMs?: number;
  shutdownPollMs?: number;
  serviceConfig?: Partial<{
    get(id: string): ServiceConfig | undefined;
    set(id: string, patch: Partial<ServiceConfig>): ServiceConfig;
  }>;
  auditLog?: ServiceLifecycleAuditLog;
}

type LifecycleReply = { status(code: number): unknown; statusCode?: number };
const STARTUP_RECONCILER_OPERATOR = 'startup-reconciler';
const DEFAULT_STARTUP_READINESS_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_PROBE_INTERVAL_MS = 2_000;

function delay(ms: number, options: { ref?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (options.ref === false) timer.unref?.();
  });
}

function settleQuietly(waitFor?: Promise<unknown>): Promise<void> | undefined {
  return waitFor?.then(
    () => undefined,
    () => undefined,
  );
}

function createInternalReply(): LifecycleReply {
  return {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

async function waitForServiceReadiness(input: {
  service: ServiceManifest;
  env: NodeJS.ProcessEnv;
  getConfig: (id: string) => ServiceConfig | undefined;
  fetchHealth: FetchServiceHealth;
  timeoutMs: number;
  intervalMs: number;
  stopWhen?: Promise<unknown>;
  stopIf?: () => Promise<boolean>;
}): Promise<boolean> {
  const timeoutMs = Math.max(0, input.timeoutMs);
  const intervalMs = Math.max(50, input.intervalMs);
  if (timeoutMs === 0) return false;

  let stopped = false;
  void input.stopWhen?.finally(() => {
    stopped = true;
  });

  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < timeoutMs) {
    const readiness = await probeServiceReadinessContract({
      service: input.service,
      env: input.env,
      config: input.getConfig(input.service.id),
      fetchHealth: input.fetchHealth,
    });
    if (readiness.ready) return true;
    if (input.stopIf && (await input.stopIf())) {
      stopped = true;
      break;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await delay(Math.min(intervalMs, remainingMs), { ref: false });
  }

  if (!stopped) {
    appendServiceLog(
      input.service.id,
      `[start] readiness check timed out after ${Math.round(timeoutMs / 1000)}s; service may still be starting\n`,
    );
  }
  return false;
}

async function probeServiceReady(input: {
  service: ServiceManifest;
  env: NodeJS.ProcessEnv;
  config: ServiceConfig | undefined;
  fetchHealth: FetchServiceHealth;
}): Promise<boolean> {
  const endpoint = resolveServiceEndpoint(input.service, input.env, input.config);
  if (!endpoint) return false;
  try {
    const health = await input.fetchHealth(resolveServiceHealthUrl(input.service, endpoint), input.service);
    return health.ok;
  } catch {
    return false;
  }
}

type ServiceReadinessContract =
  | { ready: true }
  | { ready: false; stage: 'endpoint' | 'shallow' | 'identity' | 'deep'; reason?: string };

async function probeServiceReadinessContract(input: {
  service: ServiceManifest;
  env: NodeJS.ProcessEnv;
  config: ServiceConfig | undefined;
  fetchHealth: FetchServiceHealth;
}): Promise<ServiceReadinessContract> {
  const endpoint = resolveServiceEndpoint(input.service, input.env, input.config);
  if (!endpoint) return { ready: false, stage: 'endpoint', reason: 'service endpoint is not configured' };
  try {
    const health = await input.fetchHealth(resolveServiceHealthUrl(input.service, endpoint), input.service);
    if (!health.ok) {
      return { ready: false, stage: 'shallow', reason: health.error ?? `HTTP ${health.status ?? 'unknown'}` };
    }
    const identity = serviceHealthIdentityMatches(input.service, input.config, health);
    if (!identity.matches) return { ready: false, stage: 'identity', reason: identity.reason };
    if (!input.service.deepHealthPath) return { ready: true };

    const baseUrl = endpoint.replace(/\/+$/, '');
    const deep = await input.fetchHealth(`${baseUrl}${input.service.deepHealthPath}`, input.service);
    if (!deep.ok) {
      return { ready: false, stage: 'deep', reason: deep.error ?? `HTTP ${deep.status ?? 'unknown'}` };
    }
    const deepIdentity = serviceHealthIdentityMatches(input.service, input.config, deep);
    if (!deepIdentity.matches) return { ready: false, stage: 'identity', reason: deepIdentity.reason };
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      stage: 'shallow',
      reason: error instanceof Error ? error.message : 'service readiness probe failed',
    };
  }
}

function logOwnedServiceReadinessFailure(input: {
  app: FastifyInstance;
  service: ServiceManifest;
  pids: number[];
  readiness: ServiceReadinessContract;
}): void {
  if (input.readiness.ready || input.readiness.stage === 'shallow' || input.readiness.stage === 'endpoint') return;
  if (input.readiness.stage === 'identity') {
    input.app.log.warn(
      { serviceId: input.service.id, pids: input.pids, reason: input.readiness.reason },
      'service health identity does not match desired config — replacing stale listener',
    );
    appendServiceLog(
      input.service.id,
      `[start] stale identity: ${input.readiness.reason ?? 'unknown mismatch'} — restarting\n`,
    );
    return;
  }
  input.app.log.warn(
    { serviceId: input.service.id, pids: input.pids, reason: input.readiness.reason },
    'service shallow health OK but deep health failed — killing zombie process(es)',
  );
  appendServiceLog(input.service.id, `[start] zombie detected: shallow health OK, deep health FAILED — restarting\n`);
}

export async function registerServiceLifecycleRoutes(
  app: FastifyInstance,
  options: { env?: NodeJS.ProcessEnv; fetchHealth?: FetchServiceHealth; lifecycle?: ServiceLifecycleRouteOptions } = {},
  lifecycleLock: ReturnType<typeof createServiceLifecycleLock> = createServiceLifecycleLock(),
): Promise<void> {
  const lifecycleTimeoutMs = options.lifecycle?.timeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const startupReadinessTimeoutMs =
    options.lifecycle?.startupReadinessTimeoutMs ??
    options.lifecycle?.startupGraceMs ??
    DEFAULT_STARTUP_READINESS_TIMEOUT_MS;
  const startupProbeIntervalMs = options.lifecycle?.startupProbeIntervalMs ?? DEFAULT_STARTUP_PROBE_INTERVAL_MS;
  const runner = options.lifecycle?.runScript ?? runServiceScript;
  const healthProbe = options.fetchHealth ?? fetchServiceHealth;
  const lookupPidsByPort = options.lifecycle?.findPidsByPort ?? findPidsByPort;
  const lookupProcesses = options.lifecycle?.listProcesses ?? listProcesses;
  const lookupProcessCommand = options.lifecycle?.readProcessCommand ?? readProcessCommand;
  const terminateOwnedPid = createProcessTerminator({
    killPid: options.lifecycle?.killPid,
    isProcessAlive: options.lifecycle?.isProcessAlive,
    shutdownGraceMs: options.lifecycle?.shutdownGraceMs,
    shutdownKillGraceMs: options.lifecycle?.shutdownKillGraceMs,
    shutdownPollMs: options.lifecycle?.shutdownPollMs,
  });
  const serviceConfigStore = {
    get: options.lifecycle?.serviceConfig?.get ?? getServiceConfig,
    set: options.lifecycle?.serviceConfig?.set ?? setServiceConfig,
  };
  const lifecycleEnv = options.env ?? process.env;
  // Shared pattern for transient port contention errors — used by both
  // inner startService retry and outer reconciler retry filter.
  const PORT_CONTENTION_PATTERN = /address already in use|EADDRINUSE|Errno 48/i;
  const getEffectiveConfig = (service: ServiceManifest) => {
    return resolveEffectiveServiceConfig(service, serviceConfigStore.get(service.id), lifecycleEnv);
  };
  const auditLog = options.lifecycle?.auditLog ?? getEventAuditLog();
  const { withLock } = lifecycleLock;
  const partitionServicePids = createServicePortPartitioner({
    lookupPidsByPort,
    lookupProcessCommand,
    log: app.log,
  });

  async function terminateOwnedPids(
    service: ServiceManifest,
    pids: number[],
    logContext: string,
  ): Promise<{ stopped: number[]; failed: number[]; escalated: number[] }> {
    const stopped: number[] = [];
    const failed: number[] = [];
    const escalated: number[] = [];
    for (const pid of pids) {
      const result = await terminateOwnedPid(pid);
      if (result.escalated) escalated.push(pid);
      if (result.ok) {
        if (!result.initiallyAbsent) stopped.push(pid);
      } else {
        failed.push(pid);
        app.log.warn(
          { err: result.error, serviceId: service.id, pid, escalated: result.escalated },
          `${logContext} failed`,
        );
      }
    }
    return { stopped, failed, escalated };
  }

  /**
   * Detect non-runtime environments where sidecar lifecycle should be blocked.
   * Dev worktrees set WORKTREE_PORT_OFFSET; alpha worktrees set
   * CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED. Both share ~/.cat-cafe/services.json
   * whose persistent config overrides env-level flags (EMBED_ENABLED=0 etc.),
   * so we must guard at the API level.
   */
  function isNonRuntimeEnv(): boolean {
    const offset = lifecycleEnv.WORKTREE_PORT_OFFSET;
    if (offset && offset !== '0') return true;
    return lifecycleEnv.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED === '1';
  }

  /** Reject sidecar lifecycle mutations from worktree environments. */
  function rejectIfWorktree(reply: LifecycleReply): boolean {
    if (isNonRuntimeEnv()) {
      reply.status(409);
      return true;
    }
    return false;
  }

  async function findOwnedServiceProcessPids(service: ServiceManifest): Promise<number[]> {
    const processes = await lookupProcesses();
    return processes
      .filter((processInfo) => {
        if (!processInfo.command) return false;
        return isServiceProcessCommand(processInfo.command, service);
      })
      .map((processInfo) => processInfo.pid);
  }

  async function audit(input: {
    serviceId: string;
    action: ServiceLifecycleAction;
    operator: string;
    status: 'started' | 'completed' | 'failed' | 'rejected' | 'timed_out';
    code?: number | null;
    reason?: string;
  }): Promise<void> {
    try {
      await auditLog.append({ type: SERVICE_LIFECYCLE_AUDIT_TYPE, data: input });
    } catch (error) {
      app.log.warn(
        { err: error, serviceId: input.serviceId, action: input.action },
        'service lifecycle audit append failed',
      );
    }
  }

  await registerServiceLifecycleAuditRoutes(app, auditLog);

  async function notifyServiceReady(
    service: ServiceManifest,
    operator: string,
    reason: 'already-running' | 'readiness',
  ): Promise<void> {
    const hook = options.lifecycle?.onServiceReady;
    if (!hook) return;
    try {
      await hook({ service, operator, reason });
    } catch (error) {
      app.log.warn({ err: error, serviceId: service.id, reason }, 'service ready hook failed');
    }
  }

  async function notifyServiceUnavailable(
    service: ServiceManifest,
    operator: string,
    reason: 'stop' | 'uninstall' | 'disabled',
  ): Promise<void> {
    const hook = options.lifecycle?.onServiceUnavailable;
    if (!hook) return;
    try {
      await hook({ service, operator, reason });
    } catch (error) {
      app.log.warn({ err: error, serviceId: service.id, reason }, 'service unavailable hook failed');
    }
  }

  async function runForeground(input: {
    serviceId: string;
    action: Extract<ServiceLifecycleAction, 'install' | 'uninstall'>;
    script: string;
    operator: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ ok: true; message: string } | { ok: false; error: string; output?: string }> {
    const scriptPath = resolveServiceScriptPath(input.script);
    if (!options.lifecycle?.runScript && !existsSync(scriptPath)) {
      return { ok: false, error: `${input.action} script not found: ${scriptPath}` };
    }
    appendServiceLog(input.serviceId, `[${input.action}] started: ${scriptPath}\n`);
    await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'started' });
    const result = await runWithTimeout(runner, {
      serviceId: input.serviceId,
      action: input.action,
      scriptPath,
      env: input.env,
      timeoutMs: lifecycleTimeoutMs,
    });
    if (result.timedOut) {
      appendServiceLog(
        input.serviceId,
        `[${input.action}] timed out after ${Math.round(lifecycleTimeoutMs / 1000)}s\n`,
      );
      await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'timed_out' });
      return holdLifecycleLockUntil(
        { ok: false, error: `${input.action} script timed out after ${Math.round(lifecycleTimeoutMs / 1000)}s` },
        getLifecycleRunSettlement(result),
      );
    }
    if (result.runnerError || result.code !== 0) {
      appendServiceLog(
        input.serviceId,
        `[${input.action}] failed${typeof result.code === 'number' ? ` with exit ${result.code}` : ''}\n`,
      );
      await audit({
        serviceId: input.serviceId,
        action: input.action,
        operator: input.operator,
        status: 'failed',
        code: result.code,
        reason: result.runnerError ? 'runner-error' : undefined,
      });
      return {
        ok: false,
        error: result.runnerError
          ? `${input.action} runner failed`
          : `${input.action} script failed${typeof result.code === 'number' ? ` (exit ${result.code})` : ''}`,
        output: result.output?.slice(-2000),
      };
    }
    appendServiceLog(input.serviceId, `[${input.action}] completed\n`);
    await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'completed' });
    return { ok: true, message: `${input.action} completed` };
  }

  async function stopOwnedServiceProcessesForUninstall(
    service: ServiceManifest,
  ): Promise<
    | { ok: true; stopped: number[]; foreign: number[] }
    | { ok: false; reason: string; statusCode: number; stopped: number[]; failed: number[] }
  > {
    const cfg = getEffectiveConfig(service);
    const probeService = { ...service, port: cfg?.port ?? service.port };
    const portProbe = await partitionServicePids(probeService);
    if (!portProbe.ok) {
      appendServiceLog(service.id, `[uninstall] pre-stop probe failed: ${portProbe.reason}\n`);
      return { ok: false, reason: portProbe.reason, statusCode: 503, stopped: [], failed: [] };
    }

    const { stopped, failed, escalated } = await terminateOwnedPids(
      service,
      portProbe.owned,
      'service uninstall pre-stop termination',
    );
    if (failed.length > 0) {
      appendServiceLog(service.id, `[uninstall] failed to stop owned process(es): ${failed.join(', ')}\n`);
      return { ok: false, reason: 'terminate-failed', statusCode: 502, stopped, failed };
    }
    if (stopped.length > 0) {
      appendServiceLog(service.id, `[uninstall] stopped owned process(es) before uninstall: ${stopped.join(', ')}\n`);
    }
    if (escalated.length > 0) {
      appendServiceLog(service.id, `[uninstall] escalated stubborn process(es) to SIGKILL: ${escalated.join(', ')}\n`);
    }
    if (portProbe.foreign.length > 0) {
      appendServiceLog(
        service.id,
        `[uninstall] foreign listener(s) left untouched on service port: ${portProbe.foreign.join(', ')}\n`,
      );
    }
    return { ok: true, stopped, foreign: portProbe.foreign };
  }

  async function waitForOwnedServicePortToClear(
    service: ServiceManifest,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'port-probe-unavailable' | 'foreign-port-owner' | 'owned-listener-timeout'; pids?: number[] }
  > {
    const timeoutMs = Math.max(500, Math.min(startupReadinessTimeoutMs, 5_000));
    const intervalMs = Math.max(50, Math.min(startupProbeIntervalMs, 500));
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const probe = await partitionServicePids(service);
      if (!probe.ok) return { ok: false, reason: probe.reason };
      if (probe.foreign.length > 0) return { ok: false, reason: 'foreign-port-owner', pids: probe.foreign };
      if (probe.owned.length === 0) return { ok: true };
      if (Date.now() >= deadline) return { ok: false, reason: 'owned-listener-timeout', pids: probe.owned };
      await delay(intervalMs);
    }
  }

  app.post<{ Params: { id: string }; Body: { model?: unknown; port?: unknown } }>(
    '/api/services/:id/install',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
      if (rejectIfWorktree(reply)) {
        return { error: 'Service sidecar management is disabled in worktree environments' };
      }
      const service = getServiceManifest(request.params.id);
      if (!service) {
        reply.status(404);
        return { error: `Service "${request.params.id}" not found` };
      }
      const installScript = service.scripts?.install;
      if (!installScript) return { ok: true, message: `${service.name} has no install script` };

      const installPort =
        request.body?.port ??
        (await resolveSuggestedServicePort({
          service,
          config: getEffectiveConfig(service),
          env: lifecycleEnv,
          lookupPidsByPort,
        }));
      const envResult = buildLifecycleEnv(lifecycleEnv, service.id, request.body?.model, installPort);
      if (!envResult.ok) {
        reply.status(400);
        return { error: envResult.error };
      }

      const persistPatch: { selectedModel?: string; port?: number } = {};
      if (typeof request.body?.model === 'string' && request.body.model.length > 0) {
        persistPatch.selectedModel = request.body.model;
      }
      if (typeof installPort === 'number') {
        persistPatch.port = installPort;
      }
      const priorConfig = getEffectiveConfig(service);

      return withLock(
        service.id,
        reply,
        async () => {
          const result = await runForeground({
            serviceId: service.id,
            action: 'install',
            script: installScript,
            operator,
            env: envResult.env,
          });
          if (!result.ok) {
            if (!priorConfig?.installed) {
              serviceConfigStore.set(service.id, { installed: false, enabled: false });
            }
            reply.status(lifecycleFailureStatus(result.error));
          } else {
            serviceConfigStore.set(service.id, {
              installed: true,
              ...persistPatch,
            });
          }
          return result;
        },
        { action: 'install' },
      );
    },
  );

  // POST /api/services/:id/reconfigure
  //
  // Adjust persisted model and/or port on an already-installed service
  // without rebuilding the venv. The user flow is "service installed +
  // disabled" → open install modal in edit mode → change model/port →
  // confirm. Implementation:
  //
  //   - port-only change: persist new port to services.json, no script run.
  //     Toggling the service later re-binds to the new port via start env.
  //   - model change (with or without port change): re-run the install
  //     script with new MODEL env injected. venv/pip steps are idempotent
  //     (venv exists, pip says "already satisfied"); only the snapshot
  //     download actually does work. On failure we keep the prior
  //     selectedModel/port so the user is not left in a broken half-state.
  //
  // The service MUST be installed and disabled. Enabled services must be
  // stopped first so we do not change the port out from under a running
  // sidecar (the disabled gate is what makes the "no restart juggling"
  // contract honest).
  app.post<{ Params: { id: string }; Body: { model?: unknown; port?: unknown } }>(
    '/api/services/:id/reconfigure',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
      if (rejectIfWorktree(reply)) {
        return { error: 'Service sidecar management is disabled in worktree environments' };
      }
      const service = getServiceManifest(request.params.id);
      if (!service) {
        reply.status(404);
        return { error: `Service "${request.params.id}" not found` };
      }

      const priorConfig = getEffectiveConfig(service);
      if (!priorConfig?.installed) {
        reply.status(409);
        return { error: `${service.name} must be installed before reconfiguring` };
      }
      if (priorConfig?.enabled) {
        reply.status(409);
        return { error: `${service.name} must be stopped (disabled) before reconfiguring` };
      }

      // Fail fast on malformed payload field types instead of silently
      // coercing to undefined. Without these guards `{"port": "19999"}` or
      // `{"model": 42}` would fall through and return 200 "configuration
      // unchanged", which masks client bugs and misleads operators about
      // whether the reconfigure actually applied (codex P2 2026-05-26).
      const rawModel = request.body?.model;
      if (rawModel !== undefined && rawModel !== null && typeof rawModel !== 'string') {
        reply.status(400);
        return { error: 'Invalid reconfigure payload: "model" must be a string when provided' };
      }
      const rawPort = request.body?.port;
      if (rawPort !== undefined && rawPort !== null && typeof rawPort !== 'number') {
        reply.status(400);
        return { error: 'Invalid reconfigure payload: "port" must be a number when provided' };
      }
      const requestedModel = typeof rawModel === 'string' && rawModel.length > 0 ? rawModel : undefined;
      const requestedPort = typeof rawPort === 'number' ? rawPort : undefined;
      const modelChanged = requestedModel !== undefined && requestedModel !== priorConfig?.selectedModel;
      const portChanged = requestedPort !== undefined && requestedPort !== priorConfig?.port;

      if (!modelChanged && !portChanged) {
        return { ok: true, message: `${service.name} configuration unchanged` };
      }

      // Validate inputs eagerly so we fail before grabbing the lock.
      const validateEnv = buildLifecycleEnv(
        lifecycleEnv,
        service.id,
        requestedModel ?? priorConfig?.selectedModel,
        requestedPort ?? priorConfig?.port,
      );
      if (!validateEnv.ok) {
        reply.status(400);
        return { error: validateEnv.error };
      }

      // Port-only path: pure config write, no script. Audio-capture and
      // similar model-less services land here on every reconfigure.
      if (!modelChanged) {
        return withLock(
          service.id,
          reply,
          async () => {
            const targetPort = requestedPort as number;
            serviceConfigStore.set(service.id, { port: targetPort });
            appendServiceLog(service.id, `[reconfigure] port: ${priorConfig?.port ?? 'unset'} -> ${targetPort}\n`);
            await audit({
              serviceId: service.id,
              action: 'install',
              operator,
              status: 'completed',
              reason: 'reconfigure-port-only',
            });
            return { ok: true, message: `${service.name} port updated to ${targetPort}` };
          },
          { action: 'install' },
        );
      }

      // Model change: re-run install script. venv/pip idempotent; the only
      // real work is the model snapshot download.
      const installScript = service.scripts?.install;
      if (!installScript) {
        reply.status(409);
        return { error: `${service.name} has no install script; cannot change model` };
      }

      return withLock(
        service.id,
        reply,
        async () => {
          appendServiceLog(
            service.id,
            `[reconfigure] model: ${priorConfig?.selectedModel ?? 'unset'} -> ${requestedModel}` +
              (portChanged ? `, port: ${priorConfig?.port ?? 'unset'} -> ${requestedPort}` : '') +
              '\n',
          );
          const result = await runForeground({
            serviceId: service.id,
            action: 'install',
            script: installScript,
            operator,
            env: validateEnv.env,
          });
          if (!result.ok) {
            reply.status(lifecycleFailureStatus(result.error));
            appendServiceLog(
              service.id,
              `[reconfigure] failed; prior model=${priorConfig?.selectedModel ?? 'unset'} port=${priorConfig?.port ?? 'unset'} preserved\n`,
            );
            return result;
          }
          const patch: Partial<ServiceConfig> = { installed: true };
          if (requestedModel) patch.selectedModel = requestedModel;
          if (typeof requestedPort === 'number') patch.port = requestedPort;
          serviceConfigStore.set(service.id, patch);
          await audit({
            serviceId: service.id,
            action: 'install',
            operator,
            status: 'completed',
            reason: 'reconfigure-model-change',
          });
          return { ok: true, message: `${service.name} reconfigured` };
        },
        { action: 'install' },
      );
    },
  );

  app.post<{ Params: { id: string } }>('/api/services/:id/uninstall', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    if (rejectIfWorktree(reply)) {
      return { error: 'Service sidecar management is disabled in worktree environments' };
    }
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    const uninstallScript = service.scripts?.uninstall;
    if (!uninstallScript) return { ok: true, message: `${service.name} has no uninstall script` };

    return withLock(
      service.id,
      reply,
      async () => {
        const preStop = await stopOwnedServiceProcessesForUninstall(service);
        if (!preStop.ok) {
          reply.status(preStop.statusCode);
          await audit({
            serviceId: service.id,
            action: 'uninstall',
            operator,
            status: 'failed',
            reason: preStop.reason,
          });
          return {
            ok: false,
            error: `${service.name} uninstall could not stop running service process(es)`,
            stopped: preStop.stopped,
            failed: preStop.failed,
          };
        }
        // Mirror /start: inject persisted selectedModel + port so uninstall
        // scripts that probe the install-time venv can find it (codex P1
        // 3265033601 / 3268690489). Fall back to bare env if persisted
        // config is invalid (uninstall should be tolerant of stale state).
        const cfg = getEffectiveConfig(service);
        const uninstallEnvResult = buildLifecycleEnv(lifecycleEnv, service.id, cfg?.selectedModel, cfg?.port);
        const uninstallEnv = uninstallEnvResult.ok ? uninstallEnvResult.env : { ...lifecycleEnv };
        const result = await runForeground({
          serviceId: service.id,
          action: 'uninstall',
          script: uninstallScript,
          operator,
          env: uninstallEnv,
        });
        if (!result.ok) {
          reply.status(lifecycleFailureStatus(result.error));
        } else {
          serviceConfigStore.set(service.id, { installed: false, enabled: false });
          await notifyServiceUnavailable(service, operator, 'uninstall');
        }
        return result;
      },
      { action: 'uninstall' },
    );
  });

  async function startService(service: ServiceManifest, operator: string, reply: LifecycleReply) {
    if (rejectIfWorktree(reply)) {
      return { error: 'Service sidecar management is disabled in worktree environments' };
    }

    const startScript = service.scripts?.start;
    if (!startScript) {
      reply.status(400);
      return { error: `Service "${service.id}" has no start script` };
    }

    return withLock(
      service.id,
      reply,
      async () => {
        // Probe the EFFECTIVE port: cfg.port if user installed on a custom
        // port, otherwise the manifest default. Without this, /start could
        // reject because the manifest's default port is busy (irrelevant —
        // we're not going to use it) or miss the actual port the script will
        // bind to (cfg.port). Codex P1 3268801298.
        const startEffectiveCfg = getEffectiveConfig(service);
        const startProbeService = { ...service, port: startEffectiveCfg?.port ?? service.port };
        const portProbe = await partitionServicePids(startProbeService);
        if (!portProbe.ok) {
          reply.status(503);
          await audit({
            serviceId: service.id,
            action: 'start',
            operator,
            status: 'rejected',
            reason: portProbe.reason,
          });
          return servicePortProbeUnavailableError(startProbeService.port);
        }
        if (portProbe.foreign.length > 0) {
          reply.status(409);
          await audit({
            serviceId: service.id,
            action: 'start',
            operator,
            status: 'rejected',
            reason: 'foreign-port-owner',
          });
          return { error: `Service port ${startProbeService.port} is already owned by another process` };
        }
        if (portProbe.owned.length > 0) {
          const readiness = await probeServiceReadinessContract({
            service,
            env: lifecycleEnv,
            config: startEffectiveCfg,
            fetchHealth: healthProbe,
          });
          logOwnedServiceReadinessFailure({ app, service, pids: portProbe.owned, readiness });
          if (readiness.ready) {
            // Verify at least one owned process is the current start script,
            // not a legacy additionalRuntimeScript (#863).
            let hasPrimaryProcess = false;
            for (const pid of portProbe.owned) {
              const cmd = await lookupProcessCommand(pid);
              if (cmd && isPrimaryServiceProcess(cmd, service)) {
                hasPrimaryProcess = true;
                break;
              }
            }
            if (hasPrimaryProcess) {
              serviceConfigStore.set(service.id, {
                installed: true,
                enabled: true,
                ...(startEffectiveCfg?.selectedModel ? { selectedModel: startEffectiveCfg.selectedModel } : {}),
              });
              await audit({
                serviceId: service.id,
                action: 'start',
                operator,
                status: 'completed',
                reason: 'already-running',
              });
              const reconciliation = notifyServiceReady(service, operator, 'already-running');
              return holdStartupGrace(
                { ok: true, message: `${service.name} is already running`, pids: portProbe.owned },
                startupReadinessTimeoutMs,
                reconciliation,
              );
            }
            // Legacy-only listener: log and fall through to terminate.
            app.log.info(
              { serviceId: service.id, pids: portProbe.owned },
              'owned listener is legacy — terminating for current start script',
            );
            appendServiceLog(service.id, `[start] legacy process on port — replacing with current start script\n`);
          }

          const { stopped, failed, escalated } = await terminateOwnedPids(
            service,
            portProbe.owned,
            'service start stale-listener termination',
          );
          if (failed.length > 0) {
            reply.status(502);
            await audit({
              serviceId: service.id,
              action: 'start',
              operator,
              status: 'failed',
              reason: 'stale-listener-terminate-failed',
            });
            return {
              ok: false,
              error: `${service.name} restart failed for ${failed.length} stale process(es)`,
              stopped,
              failed,
            };
          }
          if (escalated.length > 0) {
            appendServiceLog(
              service.id,
              `[start] escalated stubborn stale listener(s) to SIGKILL: ${escalated.join(', ')}\n`,
            );
          }
          if (stopped.length > 0) {
            appendServiceLog(service.id, `[start] stopped unhealthy owned listener(s): ${stopped.join(', ')}\n`);
            const clear = await waitForOwnedServicePortToClear(startProbeService);
            if (!clear.ok) {
              const statusCode =
                clear.reason === 'port-probe-unavailable' ? 503 : clear.reason === 'foreign-port-owner' ? 409 : 502;
              reply.status(statusCode);
              await audit({
                serviceId: service.id,
                action: 'start',
                operator,
                status: 'failed',
                reason: clear.reason,
              });
              return {
                ok: false,
                error: `${service.name} restart failed while waiting for stale listener to exit`,
                stopped,
                remaining: clear.pids ?? [],
              };
            }
            // Port-bindability probe: lsof -sTCP:LISTEN may report "clear" while
            // the port is still kernel-bound (hypothesized TIME_WAIT/CLOSE_WAIT)
            // after process death. Attempt an actual bind() to confirm real
            // availability before spawning the replacement process.
            // (F195 startup-reconciler gap fix)
            if (startProbeService.port) {
              const bindCheck = await waitForPortBindable(startProbeService.port, {
                timeoutMs: Math.min(startupReadinessTimeoutMs, 5_000),
                intervalMs: Math.min(startupProbeIntervalMs, 500),
              });
              if (!bindCheck.ok) {
                appendServiceLog(
                  service.id,
                  `[start] port ${startProbeService.port} not bindable after stale listener cleared (${bindCheck.lastError}); retrying spawn\n`,
                );
              }
            }
          }
        }

        const scriptPath = resolveServiceScriptPath(startScript);
        if (!options.lifecycle?.runScript && !existsSync(scriptPath)) {
          reply.status(400);
          return { error: `Start script not found: ${scriptPath}` };
        }
        // Inject persisted selectedModel + port from serviceConfig so the
        // start script sees the same env that install did. Without this,
        // services with required MODEL_ENV_VARS (whisper-stt, mlx-tts,
        // embedding-model, llm-postprocess) fail immediately at start if
        // the operator hadn't pre-defined WHISPER_MODEL / etc. in .env —
        // install succeeded but start can't read the choice. Codex P1
        // 3265033601 / 3268690489. (Supersedes upstream's inline
        // model-only injection — buildLifecycleEnv handles model + port +
        // strict validation in one call.)
        const cfg = getEffectiveConfig(service);
        const startEnvResult = buildLifecycleEnv(lifecycleEnv, service.id, cfg?.selectedModel, cfg?.port);
        if (!startEnvResult.ok) {
          reply.status(500);
          await audit({
            serviceId: service.id,
            action: 'start',
            operator,
            status: 'failed',
            reason: 'invalid-persisted-config',
          });
          return { ok: false, error: `Invalid persisted service config: ${startEnvResult.error}` };
        }
        await audit({ serviceId: service.id, action: 'start', operator, status: 'started' });

        // Bounded retry for transient port-contention (EADDRINUSE / Errno 48).
        // After killing a stale process, the port may remain kernel-bound
        // (hypothesized TIME_WAIT/CLOSE_WAIT) despite passing both lsof and
        // bind-probe checks. Retry with backoff gives the kernel time to
        // fully release the socket.
        const PORT_CONTENTION_MAX_RETRIES = 3;
        let portContentionRetries = 0;
        let result;

        for (;;) {
          result = await runWithTimeout(runner, {
            serviceId: service.id,
            action: 'start',
            scriptPath,
            env: startEnvResult.env,
            detached: true,
            timeoutMs: lifecycleTimeoutMs,
          });

          // Not a fast-fail port contention → break out of retry loop
          const isPortContention =
            !result.timedOut &&
            !result.runnerError &&
            typeof result.code === 'number' &&
            result.code !== 0 &&
            PORT_CONTENTION_PATTERN.test(result.output ?? '');

          if (!isPortContention || portContentionRetries >= PORT_CONTENTION_MAX_RETRIES) break;

          portContentionRetries++;
          const backoffMs = 1_000 * 2 ** (portContentionRetries - 1); // 1s, 2s, 4s
          appendServiceLog(
            service.id,
            `[start] port contention detected (attempt ${portContentionRetries}/${PORT_CONTENTION_MAX_RETRIES}), retrying in ${backoffMs}ms\n`,
          );

          // Wait for port to become bindable before retrying
          if (startProbeService.port) {
            await waitForPortBindable(startProbeService.port, {
              timeoutMs: backoffMs,
              intervalMs: Math.min(startupProbeIntervalMs, 500),
            });
          } else {
            await delay(backoffMs);
          }
        }

        if (result.timedOut) {
          reply.status(408);
          await audit({ serviceId: service.id, action: 'start', operator, status: 'timed_out' });
          return holdLifecycleLockUntil(
            { ok: false, error: `start script timed out after ${Math.round(lifecycleTimeoutMs / 1000)}s` },
            getLifecycleRunSettlement(result),
          );
        }
        if (result.runnerError || (typeof result.code === 'number' && result.code !== 0)) {
          reply.status(result.runnerError ? 502 : 422);
          await audit({
            serviceId: service.id,
            action: 'start',
            operator,
            status: 'failed',
            code: result.code,
            reason: result.runnerError
              ? 'runner-error'
              : portContentionRetries > 0
                ? 'port-contention-exhausted'
                : undefined,
          });
          return {
            ok: false,
            error: result.runnerError ? 'start runner failed' : `start script failed (exit ${result.code})`,
            output: result.output?.slice(-2000),
          };
        }
        const cleanExitBeforeReady =
          typeof result.code === 'number' &&
          result.code === 0 &&
          !(await probeServiceReady({ service, env: startEnvResult.env, config: cfg, fetchHealth: healthProbe }));
        if (cleanExitBeforeReady) {
          let ownedProcessPids: number[] = [];
          let ownedProcessProbeFailed = false;
          try {
            ownedProcessPids = await findOwnedServiceProcessPids(service);
          } catch (error) {
            ownedProcessProbeFailed = true;
            app.log.warn({ err: error, serviceId: service.id }, 'service start owned-process probe failed');
          }
          const detail =
            ownedProcessPids.length > 0
              ? `owned runtime process(es) still active: ${ownedProcessPids.join(', ')}`
              : ownedProcessProbeFailed
                ? 'owned runtime process probe failed'
                : 'no owned runtime process visible';
          appendServiceLog(
            service.id,
            `[start] launcher exited with code 0 before readiness; ${detail}${
              ownedProcessPids.length > 0 ? '; continuing readiness probes' : ''
            }\n`,
          );
          if (ownedProcessPids.length === 0) {
            reply.status(502);
            await audit({
              serviceId: service.id,
              action: 'start',
              operator,
              status: 'failed',
              code: result.code,
              reason: ownedProcessProbeFailed ? 'owned-process-probe-failed' : 'no-owned-runtime-process',
            });
            return {
              ok: false,
              error: `start script exited before service became reachable (exit ${result.code})`,
              output: result.output?.slice(-2000),
            };
          }
        }
        serviceConfigStore.set(service.id, {
          installed: true,
          enabled: true,
          ...(cfg?.selectedModel ? { selectedModel: cfg.selectedModel } : {}),
        });
        await audit({ serviceId: service.id, action: 'start', operator, status: 'completed', code: result.code });
        const success = { ok: true, message: `${service.name} start initiated`, pid: result.pid };
        const settlement = settleQuietly(result.settlement);
        let runtimeLivenessProbeFailed = false;
        const stopIfNoOwnedRuntimeProcess = cleanExitBeforeReady
          ? async () => {
              try {
                const ownedProcessPids = await findOwnedServiceProcessPids(service);
                if (ownedProcessPids.length > 0) return false;
                appendServiceLog(
                  service.id,
                  '[start] owned runtime process exited before readiness; clearing startup state\n',
                );
                return true;
              } catch (error) {
                if (!runtimeLivenessProbeFailed) {
                  runtimeLivenessProbeFailed = true;
                  app.log.warn({ err: error, serviceId: service.id }, 'service start runtime-liveness probe failed');
                }
                return false;
              }
            }
          : undefined;
        const readiness = waitForServiceReadiness({
          service,
          env: startEnvResult.env,
          getConfig: (id) => {
            const target = getServiceManifest(id);
            return target ? getEffectiveConfig(target) : serviceConfigStore.get(id);
          },
          fetchHealth: healthProbe,
          timeoutMs: startupReadinessTimeoutMs,
          intervalMs: startupProbeIntervalMs,
          stopWhen: cleanExitBeforeReady ? undefined : settlement,
          stopIf: stopIfNoOwnedRuntimeProcess,
        }).then(async (ready) => {
          if (ready) await notifyServiceReady(service, operator, 'readiness');
          return ready;
        });
        const releaseWhen = settlement && !cleanExitBeforeReady ? Promise.race([settlement, readiness]) : readiness;
        return holdStartupGrace(success, startupReadinessTimeoutMs, releaseWhen);
      },
      { action: 'start' },
    );
  }

  app.post<{ Params: { id: string } }>('/api/services/:id/start', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return startService(service, operator, reply);
  });

  async function stopDisabledOwnedService(service: ServiceManifest): Promise<void> {
    const reply = createInternalReply();
    const result = await withLock(
      service.id,
      reply,
      async () => {
        const cfg = getEffectiveConfig(service);
        const probeService = { ...service, port: cfg?.port ?? service.port };
        const portProbe = await partitionServicePids(probeService);
        if (!portProbe.ok) {
          app.log.warn(
            { serviceId: service.id, reason: portProbe.reason },
            'service startup reconciler could not probe disabled service',
          );
          return { ok: false };
        }
        if (portProbe.foreign.length > 0) {
          app.log.warn(
            { serviceId: service.id, pids: portProbe.foreign },
            'service startup reconciler found foreign listener on disabled service port',
          );
          return { ok: false };
        }
        if (portProbe.owned.length === 0) return { ok: true };

        const { stopped, failed, escalated } = await terminateOwnedPids(
          service,
          portProbe.owned,
          'service startup reconciler termination',
        );
        if (stopped.length > 0) {
          appendServiceLog(
            service.id,
            `[startup-reconciler] stopped disabled orphan process(es): ${stopped.join(', ')}\n`,
          );
        }
        if (escalated.length > 0) {
          appendServiceLog(
            service.id,
            `[startup-reconciler] escalated stubborn orphan process(es) to SIGKILL: ${escalated.join(', ')}\n`,
          );
        }
        await audit({
          serviceId: service.id,
          action: 'stop',
          operator: STARTUP_RECONCILER_OPERATOR,
          status: failed.length > 0 ? 'failed' : 'completed',
          reason: 'disabled-startup-cleanup',
        });
        return { ok: failed.length === 0 };
      },
      { action: 'stop' },
    );
    if ('error' in result && reply.statusCode === 409) {
      app.log.info(
        { serviceId: service.id },
        'service startup reconciler skipped disabled cleanup while lifecycle operation is active',
      );
      await audit({
        serviceId: service.id,
        action: 'stop',
        operator: STARTUP_RECONCILER_OPERATOR,
        status: 'rejected',
        reason: 'lifecycle-operation-in-progress',
      });
      return;
    }
    if ('error' in result) {
      app.log.warn({ serviceId: service.id, error: result.error }, 'service startup reconciler cleanup rejected');
      await audit({
        serviceId: service.id,
        action: 'stop',
        operator: STARTUP_RECONCILER_OPERATOR,
        status: 'rejected',
        reason: 'startup-cleanup-rejected',
      });
      return;
    }
  }

  async function reconcileServiceStartup(): Promise<void> {
    // Worktrees share ~/.cat-cafe/services.json with the runtime, so a
    // user-installed service (enabled: true) would auto-start in EVERY
    // worktree API, all fighting for the same port (e.g. 131 embed-api.py
    // zombies on 9880). Worktrees disable sidecars via EMBED_ENABLED=0 in
    // start-dev.sh, but resolveEffectiveServiceConfig reads the persistent
    // config first and never falls through to env-based derivation.
    // Guard: skip auto-start entirely when running in a non-runtime env
    // (dev worktrees via WORKTREE_PORT_OFFSET, alpha via SIDECAR_LIFECYCLE_DISABLED).
    if (isNonRuntimeEnv()) {
      app.log.info(
        'service startup reconciler skipped (worktree offset=%s, sidecar-disabled=%s)',
        lifecycleEnv.WORKTREE_PORT_OFFSET ?? '<unset>',
        lifecycleEnv.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED ?? '<unset>',
      );
      return;
    }

    const candidates = SERVICE_MANIFESTS.filter((service) => service.scripts?.start);
    if (candidates.length === 0) return;

    app.log.info({ count: candidates.length }, 'service startup reconciler checking service state');
    await Promise.all(
      candidates.map(async (service) => {
        const cfg = getEffectiveConfig(service);
        if (cfg?.enabled === false) {
          await stopDisabledOwnedService(service);
          return;
        }
        if (!(cfg?.enabled && cfg.installed !== false)) return;

        // Bounded retry for transient port contention only. The reconciler
        // retries at most RECONCILER_MAX_RETRIES times with exponential
        // backoff, but ONLY when the failure is a transient port contention
        // (EADDRINUSE / Errno 48). Permanent failures (invalid config,
        // foreign port owner, etc.) are NOT retried.
        const RECONCILER_MAX_RETRIES = 2;
        const reconcilerCfg = getEffectiveConfig(service);
        const reconcilerProbeService = { ...service, port: reconcilerCfg?.port ?? service.port };
        for (let attempt = 0; attempt <= RECONCILER_MAX_RETRIES; attempt++) {
          const reply = createInternalReply();
          const result = await startService(service, STARTUP_RECONCILER_OPERATOR, reply);
          const immediateFailure = (reply.statusCode ?? 200) >= 400;

          if (!immediateFailure) {
            // startService returned OK, but for detached processes readiness
            // isn't confirmed yet. Wait for the readiness timeout to pass,
            // then verify the service actually became reachable. This catches
            // the "completed-before-readiness" gap: the runner starts OK
            // (code: null), but the process dies with EADDRINUSE during the
            // grace period (via settlement).
            const postStartReady = await waitForServiceReadiness({
              service: reconcilerProbeService,
              env: lifecycleEnv,
              getConfig: (id) => {
                const target = getServiceManifest(id);
                return target ? getEffectiveConfig(target) : serviceConfigStore.get(id);
              },
              fetchHealth: healthProbe,
              timeoutMs: startupReadinessTimeoutMs,
              intervalMs: startupProbeIntervalMs,
            });
            if (postStartReady) break; // truly ready — done

            // Service started but never became ready — late failure.
            // Check if the OWNED process is still alive (process table,
            // not port listener). A slow-starting service may still be
            // loading its model before binding the port — it's alive but
            // invisible to lsof -sTCP:LISTEN. Using findOwnedServiceProcessPids
            // (command-matching) instead of lookupPidsByPort avoids
            // misclassifying pre-bind loading as "process died".
            // If alive → slow start or config issue → don't retry (avoids double-spawn).
            // If dead → late startup failure (e.g. EADDRINUSE crash) → retry.
            appendServiceLog(
              service.id,
              `[reconciler] service reported started but never became ready within ${startupReadinessTimeoutMs}ms\n`,
            );
            let ownedPids: number[] = [];
            try {
              ownedPids = await findOwnedServiceProcessPids(service);
            } catch (error) {
              app.log.warn(
                { err: error, serviceId: service.id },
                'service startup reconciler: owned process probe failed — assuming alive',
              );
              break; // probe failed — conservative: assume process alive, don't double-spawn
            }
            if (ownedPids.length > 0) {
              app.log.warn(
                { serviceId: service.id, pids: ownedPids, attempt: attempt + 1 },
                'service startup reconciler: owned process alive but not ready — not retrying',
              );
              break; // process alive (maybe loading model) — stop
            }
            app.log.warn(
              { serviceId: service.id, attempt: attempt + 1 },
              'service startup reconciler: process died during startup — retrying',
            );
          } else {
            // Immediate failure — only retry transient port contention.
            const isTransientPortContention =
              result != null &&
              typeof result === 'object' &&
              'output' in result &&
              PORT_CONTENTION_PATTERN.test(String((result as { output?: string }).output ?? ''));
            if (!isTransientPortContention) {
              app.log.warn(
                { serviceId: service.id, statusCode: reply.statusCode, attempt: attempt + 1 },
                'service startup reconciler: permanent failure — not retrying',
              );
              break; // non-transient — stop
            }
            app.log.warn(
              { serviceId: service.id, statusCode: reply.statusCode, attempt: attempt + 1 },
              'service startup reconciler: transient port contention',
            );
          }

          if (attempt < RECONCILER_MAX_RETRIES) {
            const backoffMs = 2_000 * 2 ** attempt; // 2s, 4s
            appendServiceLog(
              service.id,
              `[reconciler] startup attempt ${attempt + 1} failed, retrying in ${backoffMs}ms\n`,
            );
            await delay(backoffMs, { ref: false });
          }
        }
      }),
    );
  }

  if (options.lifecycle?.autoStartEnabled) {
    app.addHook('onReady', async () => {
      setImmediate(() => {
        void reconcileServiceStartup().catch((error) => {
          app.log.warn({ err: error }, 'service startup reconciler failed');
        });
      });
    });
  }

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    if (rejectIfWorktree(reply)) {
      return { error: 'Service sidecar management is disabled in worktree environments' };
    }
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return withLock(
      service.id,
      reply,
      async () => {
        // Probe the EFFECTIVE port (cfg.port ?? service.port) so /stop
        // finds the actually-listening sidecar after a custom-port
        // install (codex P1 3268801298).
        const stopEffectiveCfg = getEffectiveConfig(service);
        const stopProbeService = { ...service, port: stopEffectiveCfg?.port ?? service.port };
        const portProbe = await partitionServicePids(stopProbeService);
        if (!portProbe.ok) {
          reply.status(503);
          await audit({
            serviceId: service.id,
            action: 'stop',
            operator,
            status: 'rejected',
            reason: portProbe.reason,
          });
          return servicePortProbeUnavailableError(stopProbeService.port);
        }
        if (portProbe.foreign.length > 0) {
          reply.status(409);
          await audit({
            serviceId: service.id,
            action: 'stop',
            operator,
            status: 'rejected',
            reason: 'foreign-port-owner',
          });
          return { error: `Service port ${stopProbeService.port} is owned by another process` };
        }
        const { stopped, failed, escalated } = await terminateOwnedPids(
          service,
          portProbe.owned,
          'service stop termination',
        );
        if (failed.length > 0) {
          reply.status(502);
          await audit({
            serviceId: service.id,
            action: 'stop',
            operator,
            status: 'failed',
            reason: 'terminate-failed',
          });
          return {
            ok: false,
            error: `${service.name} stop failed for ${failed.length} process(es)`,
            stopped,
            failed,
            ...(escalated.length > 0 ? { escalated } : {}),
          };
        }
        serviceConfigStore.set(service.id, { enabled: false });
        await audit({ serviceId: service.id, action: 'stop', operator, status: 'completed' });
        await notifyServiceUnavailable(service, operator, 'stop');
        return {
          ok: true,
          message: `${service.name} stopped (${stopped.length} process(es))`,
          stopped,
          ...(escalated.length > 0 ? { escalated } : {}),
        };
      },
      { action: 'stop' },
    );
  });

  app.post<{ Params: { id: string }; Body: { enabled?: unknown; model?: unknown } }>(
    '/api/services/:id/toggle',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
      if (rejectIfWorktree(reply)) return { error: 'Service sidecar management is disabled in worktree environments' };
      const service = getServiceManifest(request.params.id);
      if (!service) {
        reply.status(404);
        return { error: `Service "${request.params.id}" not found` };
      }
      if (typeof request.body?.enabled !== 'boolean') {
        reply.status(400);
        return { error: 'Invalid body: enabled must be boolean' };
      }
      const enabled = request.body.enabled;
      return withLock(
        service.id,
        reply,
        async () => {
          const patch: { enabled: boolean; selectedModel?: string } = { enabled };
          const model = request.body?.model;
          const envResult = buildLifecycleEnv({}, service.id, model);
          if (!envResult.ok) {
            reply.status(400);
            return { error: envResult.error };
          }
          if (typeof model === 'string' && model.length > 0) {
            patch.selectedModel = model;
          }
          const config = serviceConfigStore.set(service.id, patch);
          await audit({ serviceId: service.id, action: 'toggle', operator, status: 'completed' });
          if (!enabled) await notifyServiceUnavailable(service, operator, 'disabled');
          return { ok: true, config };
        },
        { action: 'toggle' },
      );
    },
  );

  app.get<{ Params: { id: string } }>('/api/services/:id/logs', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return { serviceId: service.id, lines: readServiceLogTail(service.id) };
  });
}
