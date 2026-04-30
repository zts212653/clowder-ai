import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import {
  getAllServiceStates,
  getCachedServiceState,
  getKnownServices,
  getServiceById,
  getServiceState,
} from '../domains/services/service-registry.js';
import { resolveUserId } from '../utils/request-identity.js';

// cwd is packages/api in standard startup — resolve from file location instead
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolveScriptPath(script: string): string {
  return resolve(REPO_ROOT, script);
}

function resolveLogDir(): string {
  return process.env['LOG_DIR'] ?? resolve(REPO_ROOT, 'data/logs/api');
}

function readLogTail(serviceId: string, lines = 100): string[] {
  const logPath = resolve(resolveLogDir(), `${serviceId}.log`);
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, 'utf-8');
    return content.split('\n').slice(-lines).filter(Boolean);
  } catch {
    return [];
  }
}

function openLogFd(serviceId: string): number | null {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    return openSync(resolve(logDir, `${serviceId}.log`), 'a');
  } catch {
    return null;
  }
}

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/services', async () => {
    const known = getKnownServices();
    const cached = known.map((m) => getCachedServiceState(m.id));
    if (cached.every(Boolean)) return { services: cached };
    const states = await getAllServiceStates();
    return { services: states };
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
    const userId = resolveUserId(request);
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (!ownerId) {
      reply.status(403);
      return { error: 'Service management requires DEFAULT_OWNER_USER_ID to be configured' };
    }
    if (!userId || userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can manage services' };
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

    const scriptPath = resolveScriptPath(manifest.scripts.start);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Start script not found: ${scriptPath}` };
    }

    const logFd = openLogFd(id);
    try {
      const child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env },
      });
      child.on('error', () => {});
      if (!child.pid) {
        reply.status(500);
        return { error: `Failed to spawn start script for ${manifest.name}` };
      }
      child.unref();
      return { ok: true, message: `${manifest.name} start initiated (pid: ${child.pid})` };
    } catch {
      reply.status(500);
      return { error: `Failed to start ${manifest.name}: spawn error` };
    } finally {
      if (logFd != null) closeSync(logFd);
    }
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const userId = resolveUserId(request);
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (!ownerId) {
      reply.status(403);
      return { error: 'Service management requires DEFAULT_OWNER_USER_ID to be configured' };
    }
    if (!userId || userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can manage services' };
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
            return { ok: false, error: `Stop script for ${manifest.name} exited with code ${code}` };
          }
          return { ok: true, message: `${manifest.name} stopped via script` };
        } catch {
          return { ok: false, error: `Failed to run stop script for ${manifest.name}` };
        }
      }
    }

    if (!manifest.port) {
      reply.status(400);
      return { error: `Service "${id}" has no port or stop script` };
    }

    try {
      const child = spawn('lsof', ['-ti', `:${manifest.port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      await new Promise<void>((res, rej) => {
        child.on('error', rej);
        child.on('close', () => res());
      });
      const pids = stdout.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      return { ok: true, message: `${manifest.name} stopped (${pids.length} process(es))` };
    } catch {
      return { ok: false, error: 'Failed to stop service' };
    }
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/install', async (request, reply) => {
    const userId = resolveUserId(request);
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (!ownerId) {
      reply.status(403);
      return { error: 'Service management requires DEFAULT_OWNER_USER_ID to be configured' };
    }
    if (!userId || userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can manage services' };
    }
    const { id } = request.params;
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

    try {
      const child = spawn('bash', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let output = '';
      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      const code = await new Promise<number | null>((res, rej) => {
        child.on('error', rej);
        child.on('close', (c) => res(c));
      });

      if (code !== 0) {
        return { ok: false, error: `Install failed (exit ${code})`, output: output.slice(-2000) };
      }
      return { ok: true, message: `${manifest.name} installed successfully` };
    } catch {
      reply.status(500);
      return { ok: false, error: `Failed to run install script for ${manifest.name}` };
    }
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/logs', async (request, reply) => {
    const userId = resolveUserId(request);
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (!ownerId) {
      reply.status(403);
      return { error: 'Service management requires DEFAULT_OWNER_USER_ID to be configured' };
    }
    if (!userId || userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can view service logs' };
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
};
