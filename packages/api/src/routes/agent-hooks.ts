import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getAgentHookStatus, syncAgentHooks } from '../agent-hooks/index.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolvePersistentProjectPath } from '../utils/persistent-project-path.js';

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

/**
 * Validate an explicit project path using the shared project-path validator
 * (canonicalization, symlink resolution, denylist) and verify .cat-cafe/ exists.
 *
 * @returns `{ ok: true, path }` when valid, `{ ok: false, error }` when invalid.
 *          Returns `{ ok: true, path: null }` when no explicit path was supplied
 *          (host-scope request — no error, no project override).
 */
async function validateExplicitProjectPath(
  rawPath: string | null,
): Promise<{ ok: true; path: string | null } | { ok: false; error: string }> {
  if (!rawPath) return { ok: true, path: null };

  const validated = await resolvePersistentProjectPath(rawPath);
  if (!validated) {
    return { ok: false, error: `Invalid project path: not found, denied, or not a directory: ${rawPath}` };
  }

  if (!existsSync(join(validated, '.cat-cafe'))) {
    return { ok: false, error: `Project not initialized (missing .cat-cafe/): ${validated}` };
  }

  return { ok: true, path: validated };
}

function resolveOptions(
  options: AgentHooksRouteOptions,
  request: FastifyRequest,
  capabilityProjectRoot?: string | null,
) {
  const targetRoot = options.targetRoot ?? (isTrustedLocalApiRequest(request) ? homedir() : null);
  if (!targetRoot) return null;
  return {
    projectRoot: options.projectRoot ?? findMonorepoRoot(process.cwd()),
    targetRoot,
    // When the thread targets an external project, skill/MCP checks use
    // that project's config.  Hook templates always come from projectRoot.
    ...(capabilityProjectRoot ? { capabilityProjectRoot } : {}),
  };
}

export const agentHooksRoutes: FastifyPluginAsync<AgentHooksRouteOptions> = async (app, options) => {
  app.get('/api/agent-hooks/status', async (request, reply) => {
    const userId = resolveStrictAgentHookUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Session identity required for browser requests' };
    }

    const query = request.query as Record<string, unknown>;
    const projectValidation = await validateExplicitProjectPath(nonEmptyString(query.projectPath));
    if (!projectValidation.ok) {
      reply.status(400);
      return { error: projectValidation.error };
    }
    const resolved = resolveOptions(options, request, projectValidation.path);
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

    const body = request.body as Record<string, unknown> | null;
    const projectValidation = await validateExplicitProjectPath(nonEmptyString(body?.projectPath));
    if (!projectValidation.ok) {
      reply.status(400);
      return { error: projectValidation.error };
    }
    const resolved = resolveOptions(options, request, projectValidation.path);
    if (!resolved) {
      reply.status(403);
      return { error: 'Agent hook sync requires an explicit targetRoot or a local API host' };
    }

    // Capability-level mutations (skill/MCP sync) require owner authorization.
    // Hook file sync (writing to targetRoot) always runs for any session user.
    const ownerAuthorized = !resolveOwnerGate(userId, {
      errorMessage: 'Capability sync requires owner authorization',
    });
    return syncAgentHooks({ ...resolved, ownerAuthorized });
  });
};
