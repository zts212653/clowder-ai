import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readAccountStoreSnapshot } from '../config/account-store-snapshot.js';
import { CodexLoginManager } from '../config/codex-login-manager.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { accountToView } from './accounts-view.js';

const bodySchema = z
  .object({
    projectPath: z.string().optional(),
    attemptId: z.string().uuid().optional(),
    displayName: z.string().max(200).optional(),
  })
  .strict();
/** Same identity/project boundary as account management. No callback endpoint accepts browser tokens. */
export function registerCodexLoginRoutes(app: FastifyInstance, manager: CodexLoginManager): void {
  for (const action of ['start', 'cancel', 'confirm', 'create-new'] as const) {
    app.post(`/api/accounts/:profileId/codex/login/${action}`, async (request, reply) => {
      if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid login request' });
      const root = await resolveAccountProjectRoot(parsed.data.projectPath);
      if (!root) return reply.code(400).send({ error: 'Invalid project path' });
      const { profileId } = request.params as { profileId: string };
      try {
        let resultRef = profileId;
        if (action === 'start') manager.start(root, profileId);
        else {
          if (!parsed.data.attemptId) return reply.code(400).send({ error: 'Login attempt required' });
          if (action === 'create-new')
            resultRef = manager.createFromReview(root, profileId, parsed.data.attemptId, parsed.data.displayName);
          else if (action === 'confirm') resultRef = manager.confirm(root, profileId, parsed.data.attemptId);
          else manager.cancel(root, profileId, parsed.data.attemptId);
        }
        configEventBus.emitChange({
          source: 'accounts',
          scope: 'key',
          changedKeys: [...new Set([profileId, resultRef])],
          changeSetId: createChangeSetId(),
          timestamp: Date.now(),
        });
        const profiles = [accountToView(profileId, manager.read(root, profileId), false, root)];
        if (resultRef !== profileId) {
          const target = readAccountStoreSnapshot(root).resolve(resultRef);
          if (target.account)
            profiles.push(
              accountToView(
                resultRef,
                target.account.codex ? manager.read(root, resultRef) : target.account,
                !!target.credential,
                root,
              ),
            );
        }
        const result = profiles.find((profile) => profile.id === (action === 'confirm' ? profileId : resultRef))!;
        return { accountRef: resultRef, codex: result.codex, profiles };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : 'Codex login unavailable' });
      }
    });
  }
}
