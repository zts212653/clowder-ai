/**
 * F231 KD-19: authenticated logical profile read surface.
 *
 * The caller never supplies userId/catId/relationshipKey. Callback auth owns
 * identity and the repository projects the current cat onto its stable persona.
 */

import { PROFILE_UPDATE_TARGET_LAYERS } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
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

    // Phase E: layer query param — auth resolved BEFORE layer dispatch (INV-6).
    const layer = ((request.query as Record<string, string>)?.layer as string) ?? 'primer';
    if (!READABLE_LAYERS.has(layer)) {
      reply.status(400);
      return {
        error: 'invalid_target_layer',
        detail: `Unknown layer "${layer}"; valid: ${[...READABLE_LAYERS].join(', ')}`,
      };
    }

    if (layer === 'corpus') {
      try {
        const corpus = deps.repository.readCorpus(principal.userId);
        if (!corpus) {
          profilePointerMissing.add(1, { 'profile.layer': 'corpus' });
          reply.status(404);
          return { error: 'no_corpus', uri: deps.repository.currentCorpusUri() };
        }
        profilePointerResolved.add(1, { 'profile.layer': 'corpus' });
        return {
          layer: 'corpus',
          uri: deps.repository.currentCorpusUri(),
          content: corpus.content,
          revision: corpus.revision,
        };
      } catch {
        reply.status(503);
        return { error: 'corpus_target_unavailable', uri: deps.repository.currentCorpusUri() };
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
