import type { FastifyPluginAsync } from 'fastify';
import type { BootstrapProgress, ExpeditionBootstrapService } from '../domains/memory/ExpeditionBootstrapService.js';
import type { IndexStateManager } from '../domains/memory/IndexStateManager.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface SocketManagerLike {
  emitToUser(userId: string, event: string, data: unknown): void;
}

export interface BootstrapRoutesOptions {
  stateManager: IndexStateManager;
  bootstrapService: { bootstrap: ExpeditionBootstrapService['bootstrap'] };
  socketManager: SocketManagerLike;
  getFingerprint?: (projectPath: string) => string;
}

export const projectsBootstrapRoutes: FastifyPluginAsync<BootstrapRoutesOptions> = async (app, opts) => {
  const { stateManager, bootstrapService, socketManager } = opts;

  app.get<{ Querystring: { projectPath?: string; fingerprint?: string } }>(
    '/api/projects/index-state',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const projectPath = request.query.projectPath;
      if (!projectPath) {
        reply.status(400);
        return { error: 'projectPath query parameter is required' };
      }

      const validated = await validateProjectPath(projectPath);
      if (!validated) {
        reply.status(403);
        return { error: 'Project path not allowed' };
      }

      const fingerprint = request.query.fingerprint ?? opts.getFingerprint?.(validated);
      return stateManager.getState(validated, fingerprint);
    },
  );

  app.post<{ Body: { projectPath?: string } }>('/api/projects/bootstrap', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const projectPath = (request.body as { projectPath?: string } | null)?.projectPath;
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }

    const validated = await validateProjectPath(projectPath);
    if (!validated) {
      reply.status(403);
      return { error: 'Project path not allowed' };
    }

    // Fire-and-forget: respond immediately, bootstrap runs async
    bootstrapService
      .bootstrap(validated, {
        onProgress: (p: BootstrapProgress) => {
          socketManager.emitToUser(userId, 'index:progress', { projectPath: validated, ...p });
        },
      })
      .then((result) => {
        if (result.status === 'ready') {
          socketManager.emitToUser(userId, 'index:complete', {
            projectPath: validated,
            summary: result.summary,
            durationMs: result.durationMs,
          });
        } else if (result.status === 'failed') {
          socketManager.emitToUser(userId, 'index:failed', {
            projectPath: validated,
            error: result.error,
          });
        }
      })
      .catch((err) => {
        app.log.warn({ err, projectPath: validated }, 'Memory bootstrap failed (non-blocking)');
      });

    reply.status(202);
    return { started: true, projectPath: validated };
  });

  app.post<{ Body: { projectPath?: string } }>('/api/projects/bootstrap/snooze', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const projectPath = (request.body as { projectPath?: string } | null)?.projectPath;
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }

    const validated = await validateProjectPath(projectPath);
    if (!validated) {
      reply.status(403);
      return { error: 'Project path not allowed' };
    }

    stateManager.snooze(validated);
    const state = stateManager.getState(validated);
    return { snoozedUntil: state.snoozed_until };
  });
};
