/**
 * F231 KD-19: authenticated logical profile read surface.
 *
 * The caller never supplies userId/catId/relationshipKey. Callback auth owns
 * identity and the repository projects the current cat onto its stable persona.
 */

import { PROFILE_UPDATE_TARGET_LAYERS } from '@cat-cafe/shared';
import { CURRENT_CAPSULE_PROFILE_URI } from '@cat-cafe/shared/profile-contract';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FileProfileRepository } from '../domains/cats/services/profile/ProfileRepository.js';
import { profilePointerMissing, profilePointerResolved } from '../infrastructure/telemetry/instruments.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

const READABLE_LAYERS = new Set<string>(PROFILE_UPDATE_TARGET_LAYERS);

export interface CallbackReadProfileDeps {
  repository: FileProfileRepository;
}

export function registerCallbackReadProfileRoutes(app: FastifyInstance, deps: CallbackReadProfileDeps): void {
  app.get('/api/callbacks/profile', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const query = z
      .object({
        layer: z.string().optional(),
        expectedRevision: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_profile_query' });
    const expectedRevision = query.data.expectedRevision;

    // Phase E: layer query param — auth resolved BEFORE layer dispatch (INV-6).
    const layer = query.data.layer ?? 'primer';
    if (!READABLE_LAYERS.has(layer)) {
      reply.status(400);
      return {
        error: 'invalid_target_layer',
        detail: `Unknown layer "${layer}"; valid: ${[...READABLE_LAYERS].join(', ')}`,
      };
    }

    if (layer === 'corpus' || layer === 'capsule') {
      const uri = layer === 'capsule' ? CURRENT_CAPSULE_PROFILE_URI : deps.repository.currentCorpusUri();
      try {
        const corpus =
          layer === 'capsule'
            ? deps.repository.readCapsule(principal.userId)
            : deps.repository.readCorpus(principal.userId);
        if (!corpus) {
          profilePointerMissing.add(1, { 'profile.layer': layer });
          reply.status(404);
          return { error: `no_${layer}`, uri };
        }
        if (expectedRevision && corpus.revision !== expectedRevision) {
          return reply.status(409).send({ error: 'profile_revision_changed' });
        }
        profilePointerResolved.add(1, { 'profile.layer': layer });
        return {
          layer,
          uri,
          content: corpus.content,
          revision: corpus.revision,
        };
      } catch {
        reply.status(503);
        return { error: `${layer}_target_unavailable`, uri };
      }
    }

    // Default: primer — existing flow.
    let scope;
    try {
      scope = deps.repository.scope(principal.userId, principal.catId as string);
    } catch {
      profilePointerMissing.add(1, { 'profile.layer': 'primer' });
      reply.status(404);
      return { error: 'no_primer', uri: deps.repository.currentRelationshipUri() };
    }

    const primer = deps.repository.readPrimer(scope);
    if (!primer) {
      profilePointerMissing.add(1, { 'profile.layer': 'primer' });
      reply.status(404);
      return { error: 'no_primer', uri: deps.repository.currentRelationshipUri() };
    }

    if (expectedRevision && primer.revision !== expectedRevision) {
      return reply.status(409).send({ error: 'profile_revision_changed' });
    }
    profilePointerResolved.add(1, { 'profile.layer': 'primer' });

    return {
      layer: 'primer',
      uri: deps.repository.currentRelationshipUri(),
      relationshipKey: scope.relationshipKey,
      content: primer.content,
      revision: primer.revision,
    };
  });
}
