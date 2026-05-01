import { homedir } from 'node:os';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getAgentHookStatus, syncAgentHooks } from '../agent-hooks/index.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';

export interface AgentHooksRouteOptions {
  projectRoot?: string;
  targetRoot?: string;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveStrictAgentHookUserId(request: FastifyRequest): string | null {
  const fromSession = nonEmptyString((request as FastifyRequest & { sessionUserId?: string }).sessionUserId);
  return fromSession;
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  return request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';
}

function normalizeHostName(rawHost: string): string | null {
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 1 ? trimmed.slice(1, end) : null;
  }

  if (trimmed === '::1') return trimmed;
  const colonCount = [...trimmed].filter((char) => char === ':').length;
  if (colonCount > 1) return trimmed;

  return trimmed.split(':')[0] ?? null;
}

function headerHostName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return normalizeHostName(value);
}

function originHostName(value: string): string | null {
  try {
    return normalizeHostName(new URL(value).host);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string | null): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function hasTrustedLocalOrigin(value: unknown): boolean {
  const origin = nonEmptyString(value);
  if (!origin) return true;
  return isLoopbackHost(originHostName(origin));
}

function isTrustedLocalApiRequest(request: FastifyRequest): boolean {
  if (!isLoopbackRequest(request)) return false;

  const host = headerHostName(request.headers.host);
  if (!isLoopbackHost(host)) return false;

  return hasTrustedLocalOrigin(request.headers.origin);
}

function resolveOptions(options: AgentHooksRouteOptions, request: FastifyRequest) {
  const targetRoot = options.targetRoot ?? (isTrustedLocalApiRequest(request) ? homedir() : null);
  if (!targetRoot) return null;
  return {
    projectRoot: options.projectRoot ?? findMonorepoRoot(process.cwd()),
    targetRoot,
  };
}

export const agentHooksRoutes: FastifyPluginAsync<AgentHooksRouteOptions> = async (app, options) => {
  app.get('/api/agent-hooks/status', async (request, reply) => {
    const userId = resolveStrictAgentHookUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Session identity required for browser requests' };
    }

    const resolved = resolveOptions(options, request);
    if (!resolved) {
      reply.status(403);
      return { error: 'Agent hook health requires an explicit targetRoot or a local API host' };
    }

    return getAgentHookStatus(resolved);
  });

  app.post('/api/agent-hooks/sync', async (request, reply) => {
    const userId = resolveStrictAgentHookUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Session identity required for browser requests' };
    }

    const resolved = resolveOptions(options, request);
    if (!resolved) {
      reply.status(403);
      return { error: 'Agent hook sync requires an explicit targetRoot or a local API host' };
    }

    return syncAgentHooks(resolved);
  });
};
