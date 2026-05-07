import { execSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getServiceConfig, setServiceConfig } from '../domains/services/service-config.js';
import { MODEL_ENV_VARS } from '../domains/services/service-manifest.js';
import {
  getAllServiceStates,
  getKnownServices,
  getServiceById,
  getServiceState,
  resolveServiceEndpoint,
} from '../domains/services/service-registry.js';
import { resolveUserId } from '../utils/request-identity.js';

// cwd is packages/api in standard startup — resolve from file location instead
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// HuggingFace repo-id: org/model-name with optional quantization suffixes
const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/;

function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model) && model.length <= 200;
}

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
    const fd = openSync(logPath, 'r');
    try {
      const stat = fstatSync(fd);
      const maxRead = 256 * 1024;
      const readSize = Math.min(stat.size, maxRead);
      if (readSize === 0) return [];
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      return buf.toString('utf-8').split('\n').slice(-lines).filter(Boolean);
    } finally {
      closeSync(fd);
    }
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

function appendLog(serviceId: string, chunk: string): void {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, `${serviceId}.log`), chunk);
  } catch {
    /* best effort */
  }
}

/** Check if a PID's command line matches the service (prevents killing unrelated processes). */
function isServiceProcess(pid: number, manifest: { scripts: { start?: string } }): boolean {
  const startScript = manifest.scripts.start;
  if (!startScript) return false;
  try {
    const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8', timeout: 2000 }).trim();
    // Match if the process command contains the service script name
    const scriptBasename = startScript.replace(/.*\//, '');
    return cmd.includes(scriptBasename) || cmd.includes(startScript);
  } catch {
    // Process may have already exited — treat as non-matching
    return false;
  }
}

function checkServiceOwner(request: Parameters<typeof resolveUserId>[0]): string | null {
  const userId = resolveUserId(request);
  if (!userId) return 'Authentication required';
  const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
  if (ownerId && userId !== ownerId) return 'Only the owner can manage services';
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
      reply.status(403);
      return { error: ownerErr };
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
      const pgrep = spawn('pgrep', ['-f', manifest.scripts.start], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let pout = '';
      pgrep.stdout?.on('data', (d: Buffer) => {
        pout += d.toString();
      });
      await new Promise<void>((res) => {
        pgrep.on('close', () => res());
        pgrep.on('error', () => res());
      });
      if (pout.trim()) {
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
      reply.status(403);
      return { error: ownerErr };
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
      const myPid = process.pid;
      const candidatePids = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);
      const safePids = candidatePids.filter((pid) => isServiceProcess(pid, manifest));
      for (const pid of safePids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      return { ok: true, message: `${manifest.name} stopped (${safePids.length} process(es))` };
    } catch {
      return { ok: false, error: 'Failed to stop service' };
    }
  });

  app.post<{ Params: { id: string }; Body: { model?: string } }>(
    '/api/services/:id/install',
    async (request, reply) => {
      const ownerErr = checkServiceOwner(request);
      if (ownerErr) {
        reply.status(403);
        return { error: ownerErr };
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
      reply.status(403);
      return { error: ownerErr };
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
      reply.status(403);
      return { error: ownerErr };
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
        reply.status(403);
        return { error: ownerErr };
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
