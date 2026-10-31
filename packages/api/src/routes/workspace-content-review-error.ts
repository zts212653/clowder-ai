import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { WorkspaceContentReviewError } from '../domains/collaborative-content/workspace-review/errors.js';
import { VideoProjectAccessError } from '../domains/video-studio/project/access.js';
import { WorkspaceContentSourceError } from '../domains/workspace/workspace-content-source.js';

const SOURCE_ERROR_STATUS: Record<WorkspaceContentSourceError['code'], number> = {
  access_denied: 403,
  not_found: 404,
  revision_changed: 409,
  too_large: 413,
  unsupported_media: 415,
  unsupported_text: 415,
};
const REVIEW_ERROR_STATUS: Record<WorkspaceContentReviewError['code'], number> = {
  access_denied: 403,
  not_found: 404,
  invalid_action: 400,
  operation_reused: 409,
  revision_conflict: 409,
  source_changed: 409,
  source_unavailable: 409,
  version_pending: 409,
  unsupported_content: 415,
  existing_contexts: 409,
};
export function replyWorkspaceContentReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof VideoProjectAccessError) return reply.code(403).send({ error: { code: error.code } });
  if (error instanceof WorkspaceContentSourceError) {
    return reply.code(SOURCE_ERROR_STATUS[error.code]).send({ error: { code: error.code } });
  }
  if (error instanceof WorkspaceContentReviewError) {
    return reply
      .code(REVIEW_ERROR_STATUS[error.code])
      .send({ error: { code: error.code, ...(error.contexts ? { contexts: error.contexts } : {}) } });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_request' } });
  return reply.code(500).send({ error: { code: 'workspace_content_unavailable' } });
}
