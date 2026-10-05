import { realpathSync } from 'node:fs';
import type { AgyNativeCodingGrantConfig, CatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { resolveAgyNativeCodingGrant } from '../domains/cats/services/agents/providers/agy-native/agy-native-coding-grant.js';
import { preflightAgyNativeWorkspace } from '../domains/cats/services/agents/providers/agy-native/agy-native-policy.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

export interface NativeTestGrantRouteDeps {
  readonly taskStore?: Pick<ITaskStore, 'get'>;
  readonly threadStore?: Pick<IThreadStore, 'get'>;
  readonly getGrantConfig: (catId: CatId) => AgyNativeCodingGrantConfig | undefined;
}

export function registerCallbackNativeTestGrantRoute(app: FastifyInstance, deps: NativeTestGrantRouteDeps): void {
  app.get('/api/callbacks/native-test-grant', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const policy = request.callbackAuth?.toolExecutionPolicy;
    if (
      principal.kind !== 'invocation' ||
      policy?.mode !== 'callback_allowlist' ||
      !policy.allowedCallbackRoutes.includes('GET /api/callbacks/native-test-grant')
    ) {
      return reply.status(403).send({ error: 'native_test_grant_forbidden' });
    }
    if (!deps.taskStore || !deps.threadStore) {
      return reply.status(503).send({ error: 'native_test_grant_owner_unavailable' });
    }
    try {
      const grant = await resolveAgyNativeCodingGrant({
        grant: deps.getGrantConfig(principal.catId),
        threadId: principal.threadId,
        catId: principal.catId,
        userId: principal.userId,
        taskStore: deps.taskStore,
      });
      if (!grant) return reply.status(403).send({ error: 'native_test_grant_forbidden' });
      const thread = await deps.threadStore.get(principal.threadId);
      if (!thread?.projectPath || realpathSync(thread.projectPath) !== grant.workspaceRoot) {
        return reply.status(403).send({ error: 'native_test_workspace_mismatch' });
      }
      if (!preflightAgyNativeWorkspace(grant.workspaceRoot).ok) {
        return reply.status(403).send({ error: 'native_test_workspace_refused' });
      }
      return { v: 1, taskId: grant.taskId, workspaceRoot: grant.workspaceRoot, testFile: grant.testFile };
    } catch {
      return reply.status(403).send({ error: 'native_test_grant_unavailable' });
    }
  });
}
