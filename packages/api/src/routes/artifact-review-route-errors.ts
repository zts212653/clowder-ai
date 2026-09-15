import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { ArtifactReviewError } from '../domains/collaborative-content/artifact-review/errors.js';
import { MediaOwnerError } from '../domains/video-studio/content-owner/media-errors.js';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
} from '../domains/video-studio/content-owner/service.js';

export function replyArtifactReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid_request', details: error.issues });
  if (error instanceof ArtifactReviewError || error instanceof MediaOwnerError) {
    return reply.code(reviewErrorStatus(error.code)).send({ error: error.code });
  }
  if (error instanceof ContentOwnerNotFoundError) return reply.code(404).send({ error: 'not_found' });
  if (error instanceof ContentOwnerConflictError || error instanceof ContentOwnerIdempotencyError)
    return reply.code(409).send({ error: 'asset_changed' });
  throw error;
}

function reviewErrorStatus(code: string): number {
  if (['access_denied', 'owner_required', 'human_required'].includes(code)) return 403;
  if (code === 'not_found') return 404;
  if (['invalid_action', 'invalid_media'].includes(code)) return 400;
  if (code === 'media_unavailable') return 503;
  return 409;
}
