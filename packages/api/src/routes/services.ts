import { spawn } from 'node:child_process';
import { closeSync, existsSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { checkProcessByPattern, findPidsByPort, isServiceProcess } from '../domains/services/process-utils.js';
import { getServiceConfig, setServiceConfig } from '../domains/services/service-config.js';
import {
  appendLog,
  isValidModelId,
  openLogFd,
  readLogTail,
  resolveScriptPath,
} from '../domains/services/service-logs.js';
import { MODEL_ENV_VARS } from '../domains/services/service-manifest.js';
import {
  getAllServiceStates,
  getKnownServices,
  getServiceById,
  getServiceState,
  resolveServiceEndpoint,
} from '../domains/services/service-registry.js';
import { resolveUserId } from '../utils/request-identity.js';

function checkServiceOwner(request: Parameters<typeof resolveUserId>[0]): { status: 401 | 403; error: string } | null {
  const userId = resolveUserId(request);
  if (!userId) return { status: 401, error: 'Authentication required' };
  const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
  if (ownerId && userId !== ownerId) return { status: 403, error: 'Only the owner can manage services' };
  return null;
}

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/services', async () => {
    const states = await getAllServiceStates();
    return { services: states };
  });

  app.get('/api/services/endpoints', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const endpoints: Record<string, string | null> = {};
    for (const manifest of getKnownServices()) {
      endpoints[manifest.id] = resolveServiceEndpoint(manifest);
    }
    return { endpoints };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/health', async (request, reply) => {
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const state = await getServiceState(manifest);
    return state;
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/start', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    if (!manifest.scripts.start) {
      reply.status(400);
      return { error: `Service "${id}" has no start script` };
    }

    const current = await getServiceState(manifest);
    if (current.status === 'running') {
      return { ok: true, message: `${manifest.name} is already running` };
    }

    if (manifest.port) {
      const existingProcess = await checkProcessByPattern(manifest.scripts.start);
      if (existingProcess) {
        return { ok: true, message: `${manifest.name} is still starting (existing process found)` };
      }
    }

    const scriptPath = resolveScriptPath(manifest.scripts.start);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Start script not found: ${scriptPath}` };
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    const cfg = getServiceConfig(id);
    if (cfg.selectedModel && isValidModelId(cfg.selectedModel)) {
      const envKey = MODEL_ENV_VARS[id];
      if (envKey) env[envKey] = cfg.selectedModel;
    }

    const logFd = openLogFd(id);
    try {
      const child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
        env,
      });
      child.on('error', () => {});
      if (!child.pid) {
        reply.status(500);
        return { error: `Failed to spawn start script for ${manifest.name}` };
      }

      const earlyExit = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.unref();
          resolve(null);
        }, 2000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      if (earlyExit !== null) {
        const logs = readLogTail(id, 20);
        reply.status(500);
        return { error: `${manifest.name} exited immediately (code ${earlyExit})`, logs };
      }
      return { ok: true, message: `${manifest.name} start initiated (pid: ${child.pid})` };
    } catch {
      reply.status(500);
      return { error: `Failed to start ${manifest.name}: spawn error` };
    } finally {
      if (logFd != null) closeSync(logFd);
    }
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }

    if (manifest.scripts.stop) {
      const scriptPath = resolveScriptPath(manifest.scripts.stop);
      if (existsSync(scriptPath)) {
        try {
          const child = spawn('bash', [scriptPath], { stdio: 'ignore' });
          const code = await new Promise<number | null>((res, rej) => {
            child.on('error', rej);
            child.on('close', (c) => res(c));
          });
          if (code !== 0) {
            reply.status(500);
            return { ok: false, error: `Stop script for ${manifest.name} exited with code ${code}` };
          }
          return { ok: true, message: `${manifest.name} stopped via script` };
        } catch {
          reply.status(500);
          return { ok: false, error: `Failed to run stop script for ${manifest.name}` };
        }
      }
    }

    if (!manifest.port) {
      reply.status(400);
      return { error: `Service "${id}" has no port or stop script` };
    }

    try {
      const candidatePids = await findPidsByPort(manifest.port);
      const killed: number[] = [];
      for (const pid of candidatePids) {
        if (!isServiceProcess(pid, manifest)) continue;
        try {
          process.kill(pid, 'SIGTERM');
          killed.push(pid);
        } catch {
          /* already gone */
        }
      }
      return { ok: true, message: `${manifest.name} stopped (${killed.length} process(es))` };
    } catch {
      reply.status(500);
      return { ok: false, error: 'Failed to stop service' };
    }
  });

  app.post<{ Params: { id: string }; Body: { model?: string } }>(
    '/api/services/:id/install',
    async (request, reply) => {
      const ownerErr = checkServiceOwner(request);
      if (ownerErr) {
        reply.status(ownerErr.status);
        return { error: ownerErr.error };
      }
      const { id } = request.params;
      const body = (request.body ?? {}) as { model?: string };
      const manifest = getServiceById(id);
      if (!manifest) {
        reply.status(404);
        return { error: `Service "${id}" not found` };
      }
      if (!manifest.scripts.install) {
        return { ok: true, message: `${manifest.name} has no install script (dependencies managed externally)` };
      }

      const scriptPath = resolveScriptPath(manifest.scripts.install);
      if (!existsSync(scriptPath)) {
        reply.status(400);
        return { error: `Install script not found: ${scriptPath}` };
      }

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (body.model) {
        if (!isValidModelId(body.model)) {
          reply.status(400);
          return { error: 'Invalid model ID format (expected: org/model-name)' };
        }
        const envKey = MODEL_ENV_VARS[id];
        if (envKey) env[envKey] = body.model;
      }

      try {
        const child = spawn('bash', [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
        let output = '';
        const MAX_OUTPUT = 8192;
        const appendOutput = (s: string) => {
          output += s;
          if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
        };
        child.stdout?.on('data', (d: Buffer) => {
          const s = d.toString();
          appendOutput(s);
          appendLog(id, s);
        });
        child.stderr?.on('data', (d: Buffer) => {
          const s = d.toString();
          appendOutput(s);
          appendLog(id, s);
        });
        const code = await new Promise<number | null>((res, rej) => {
          child.on('error', rej);
          child.on('close', (c) => res(c));
        });

        if (code !== 0) {
          reply.status(422);
          return { ok: false, error: `Install failed (exit ${code})`, output: output.slice(-2000) };
        }

        if (manifest.scripts.start && getServiceConfig(id).enabled) {
          const startScript = resolveScriptPath(manifest.scripts.start);
          if (existsSync(startScript)) {
            const startEnv: Record<string, string> = { ...process.env } as Record<string, string>;
            const cfg = getServiceConfig(id);
            if (cfg.selectedModel && isValidModelId(cfg.selectedModel)) {
              const ek = MODEL_ENV_VARS[id];
              if (ek) startEnv[ek] = cfg.selectedModel;
            }
            const startFd = openLogFd(id);
            const startChild = spawn('bash', [startScript], {
              detached: true,
              stdio: startFd != null ? ['ignore', startFd, startFd] : 'ignore',
              env: startEnv,
            });
            startChild.on('error', () => {});
            startChild.unref();
            if (startFd != null) closeSync(startFd);
          }
        }

        return { ok: true, message: `${manifest.name} installed successfully` };
      } catch {
        reply.status(500);
        return { ok: false, error: `Failed to run install script for ${manifest.name}` };
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/services/:id/uninstall', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    if (!manifest.scripts.uninstall) {
      return { ok: true, message: `${manifest.name} has no uninstall script` };
    }

    const scriptPath = resolveScriptPath(manifest.scripts.uninstall);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Uninstall script not found: ${scriptPath}` };
    }

    try {
      const child = spawn('bash', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let output = '';
      const MAX_OUTPUT = 8192;
      const appendOutput = (s: string) => {
        output += s;
        if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
      };
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        appendOutput(s);
        appendLog(id, s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        appendOutput(s);
        appendLog(id, s);
      });
      const code = await new Promise<number | null>((res, rej) => {
        child.on('error', rej);
        child.on('close', (c) => res(c));
      });

      if (code !== 0) {
        reply.status(422);
        return { ok: false, error: `Uninstall failed (exit ${code})`, output: output.slice(-2000) };
      }
      return { ok: true, message: `${manifest.name} uninstalled successfully` };
    } catch {
      reply.status(500);
      return { ok: false, error: `Failed to run uninstall script for ${manifest.name}` };
    }
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/logs', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const lines = readLogTail(id);
    return { serviceId: id, lines };
  });

  app.post<{ Params: { id: string }; Body: { enabled: boolean; model?: string } }>(
    '/api/services/:id/toggle',
    async (request, reply) => {
      const ownerErr = checkServiceOwner(request);
      if (ownerErr) {
        reply.status(ownerErr.status);
        return { error: ownerErr.error };
      }
      const { id } = request.params;
      const toggleSchema = z.object({ enabled: z.boolean(), model: z.string().optional() });
      const parsed = toggleSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid body', details: parsed.error.issues };
      }
      const body = parsed.data;
      const manifest = getServiceById(id);
      if (!manifest) {
        reply.status(404);
        return { error: `Service "${id}" not found` };
      }

      const patch: { enabled: boolean; selectedModel?: string } = { enabled: body.enabled };
      if (body.model) {
        if (!isValidModelId(body.model)) {
          reply.status(400);
          return { error: 'Invalid model ID format (expected: org/model-name)' };
        }
        patch.selectedModel = body.model;
      }
      setServiceConfig(id, patch);

      return { ok: true, config: getServiceConfig(id) };
    },
  );
};
