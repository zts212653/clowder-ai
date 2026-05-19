import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { setServiceConfig } from '../domains/services/service-config.js';
import {
  findPidsByPort,
  readProcessCommand,
  readServiceLogTail,
  resolveServiceScriptPath,
  runServiceScript,
  type ServiceLifecycleAction,
  type ServiceLifecycleRunner,
} from '../domains/services/service-lifecycle.js';
import { getServiceManifest } from '../domains/services/service-manifest.js';
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
import { createServicePortPartitioner, servicePortProbeUnavailableError } from './services-lifecycle-port.js';

export interface ServiceLifecycleRouteOptions {
  runScript?: ServiceLifecycleRunner;
  timeoutMs?: number;
  startupGraceMs?: number;
  findPidsByPort?: (port: number) => Promise<number[]>;
  readProcessCommand?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  serviceConfig?: {
    set(
      id: string,
      patch: { enabled?: boolean; selectedModel?: string; port?: number },
    ): { enabled: boolean; selectedModel?: string; port?: number };
  };
  auditLog?: ServiceLifecycleAuditLog;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function registerServiceLifecycleRoutes(
  app: FastifyInstance,
  options: { env?: NodeJS.ProcessEnv; lifecycle?: ServiceLifecycleRouteOptions } = {},
): Promise<void> {
  const lifecycleTimeoutMs = options.lifecycle?.timeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const runner = options.lifecycle?.runScript ?? runServiceScript;
  const lookupPidsByPort = options.lifecycle?.findPidsByPort ?? findPidsByPort;
  const lookupProcessCommand = options.lifecycle?.readProcessCommand ?? readProcessCommand;
  const terminatePid =
    options.lifecycle?.killPid ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const serviceConfigStore = options.lifecycle?.serviceConfig ?? { set: setServiceConfig };
  const auditLog = options.lifecycle?.auditLog ?? getEventAuditLog();
  const { withLock } = createServiceLifecycleLock();
  const partitionServicePids = createServicePortPartitioner({
    lookupPidsByPort,
    lookupProcessCommand,
    log: app.log,
  });

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
    await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'started' });
    const result = await runWithTimeout(runner, {
      serviceId: input.serviceId,
      action: input.action,
      scriptPath,
      env: input.env,
      timeoutMs: lifecycleTimeoutMs,
    });
    if (result.timedOut) {
      await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'timed_out' });
      return holdLifecycleLockUntil(
        { ok: false, error: `${input.action} script timed out after ${Math.round(lifecycleTimeoutMs / 1000)}s` },
        getLifecycleRunSettlement(result),
      );
    }
    if (result.runnerError || result.code !== 0) {
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
    await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'completed' });
    return { ok: true, message: `${input.action} completed` };
  }

  app.post<{ Params: { id: string }; Body: { model?: unknown } }>(
    '/api/services/:id/install',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
      const service = getServiceManifest(request.params.id);
      if (!service) {
        reply.status(404);
        return { error: `Service "${request.params.id}" not found` };
      }
      const installScript = service.scripts?.install;
      if (!installScript) return { ok: true, message: `${service.name} has no install script` };

      const envResult = buildLifecycleEnv(options.env ?? process.env, service.id, request.body?.model);
      if (!envResult.ok) {
        reply.status(400);
        return { error: envResult.error };
      }

      return withLock(service.id, reply, async () => {
        const result = await runForeground({
          serviceId: service.id,
          action: 'install',
          script: installScript,
          operator,
          env: envResult.env,
        });
        if (!result.ok) reply.status(lifecycleFailureStatus(result.error));
        return result;
      });
    },
  );

  app.post<{ Params: { id: string } }>('/api/services/:id/uninstall', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    const uninstallScript = service.scripts?.uninstall;
    if (!uninstallScript) return { ok: true, message: `${service.name} has no uninstall script` };

    return withLock(service.id, reply, async () => {
      const result = await runForeground({
        serviceId: service.id,
        action: 'uninstall',
        script: uninstallScript,
        operator,
        env: { ...(options.env ?? process.env) },
      });
      if (!result.ok) reply.status(lifecycleFailureStatus(result.error));
      return result;
    });
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/start', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    const startScript = service.scripts?.start;
    if (!startScript) {
      reply.status(400);
      return { error: `Service "${service.id}" has no start script` };
    }
    const portProbe = await partitionServicePids(service);
    if (!portProbe.ok) {
      reply.status(503);
      await audit({ serviceId: service.id, action: 'start', operator, status: 'rejected', reason: portProbe.reason });
      return servicePortProbeUnavailableError(service.port);
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
      return { error: `Service port ${service.port} is already owned by another process` };
    }
    if (portProbe.owned.length > 0) {
      await audit({
        serviceId: service.id,
        action: 'start',
        operator,
        status: 'completed',
        reason: 'already-running',
      });
      return { ok: true, message: `${service.name} is already running`, pids: portProbe.owned };
    }

    return withLock(
      service.id,
      reply,
      async () => {
        const scriptPath = resolveServiceScriptPath(startScript);
        if (!options.lifecycle?.runScript && !existsSync(scriptPath)) {
          reply.status(400);
          return { error: `Start script not found: ${scriptPath}` };
        }
        await audit({ serviceId: service.id, action: 'start', operator, status: 'started' });
        const result = await runWithTimeout(runner, {
          serviceId: service.id,
          action: 'start',
          scriptPath,
          env: { ...(options.env ?? process.env) },
          detached: true,
          timeoutMs: lifecycleTimeoutMs,
        });
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
            reason: result.runnerError ? 'runner-error' : undefined,
          });
          return {
            ok: false,
            error: result.runnerError ? 'start runner failed' : `start script failed (exit ${result.code})`,
            output: result.output?.slice(-2000),
          };
        }
        await audit({ serviceId: service.id, action: 'start', operator, status: 'completed', code: result.code });
        const success = { ok: true, message: `${service.name} start initiated`, pid: result.pid };
        return holdStartupGrace(success, options.lifecycle?.startupGraceMs);
      },
      { action: 'start' },
    );
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return withLock(service.id, reply, async () => {
      const portProbe = await partitionServicePids(service);
      if (!portProbe.ok) {
        reply.status(503);
        await audit({ serviceId: service.id, action: 'stop', operator, status: 'rejected', reason: portProbe.reason });
        return servicePortProbeUnavailableError(service.port);
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
        return { error: `Service port ${service.port} is owned by another process` };
      }
      const stopped: number[] = [];
      const failed: number[] = [];
      for (const pid of portProbe.owned) {
        try {
          terminatePid(pid, 'SIGTERM');
          stopped.push(pid);
        } catch (error) {
          if (hasErrorCode(error, 'ESRCH')) continue;
          failed.push(pid);
          app.log.warn({ err: error, serviceId: service.id, pid }, 'service stop terminate failed');
        }
      }
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
        };
      }
      await audit({ serviceId: service.id, action: 'stop', operator, status: 'completed' });
      return { ok: true, message: `${service.name} stopped (${stopped.length} process(es))`, stopped };
    });
  });

  app.post<{ Params: { id: string }; Body: { enabled?: unknown; model?: unknown } }>(
    '/api/services/:id/toggle',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
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
      return withLock(service.id, reply, async () => {
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
        return { ok: true, config };
      });
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
