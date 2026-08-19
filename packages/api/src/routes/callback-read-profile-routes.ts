/**
 * F231 KD-19: authenticated logical profile read surface.
 *
 * The caller never supplies userId/catId/relationshipKey. Callback auth owns
 * identity and the repository projects the current cat onto its stable persona.
 */

import type { FastifyInstance } from 'fastify';
import type { FileProfileRepository } from '../domains/cats/services/profile/ProfileRepository.js';
import { profilePointerMissing, profilePointerResolved } from '../infrastructure/telemetry/instruments.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

export interface CallbackReadProfileDeps {
  repository: FileProfileRepository;
}

export function registerCallbackReadProfileRoutes(app: FastifyInstance, deps: CallbackReadProfileDeps): void {
  app.get('/api/callbacks/profile', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    let scope;
    try {
      scope = deps.repository.scope(principal.userId, principal.catId as string);
    } catch (err) {
      profilePointerMissing.add(1);
      reply.status(404);
      return { error: err instanceof Error ? err.message : 'Profile persona not found' };
    }

    const primer = deps.repository.readPrimer(scope);
    if (!primer) {
      profilePointerMissing.add(1);
      reply.status(404);
      return {
        error: `No relationship primer found for current persona "${scope.relationshipKey}"`,
        uri: deps.repository.currentRelationshipUri(),
      };
    }

    profilePointerResolved.add(1);

    return {
      uri: deps.repository.currentRelationshipUri(),
      relationshipKey: scope.relationshipKey,
      content: primer.content,
    };
  });
}
