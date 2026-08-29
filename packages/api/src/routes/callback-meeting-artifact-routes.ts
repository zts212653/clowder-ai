import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type MeetingArtifactReadInput,
  MeetingArtifactResourceError,
  type MeetingArtifactResourceService,
} from '../domains/signal-intake/MeetingArtifactResourceService.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';

export interface MeetingArtifactReaderHolder {
  current?: Pick<MeetingArtifactResourceService, 'read'>;
}

export interface CallbackMeetingArtifactRoutesOptions {
  readonly readerHolder: MeetingArtifactReaderHolder;
  readonly threadStore?: Pick<IThreadStore, 'get' | 'list'>;
}

const readSchema = z.object({
  threadId: z.string().min(1).optional(),
  resourceRef: z.string().min(1).max(1_024),
  view: z.enum(['overview', 'outline', 'content']),
  maxChars: z.number().int().min(1).max(12_000),
  maxTokens: z.number().int().min(1).max(3_000),
  cursor: z.string().min(1).max(1_024).optional(),
  speakers: z.array(z.string().trim().min(1).max(128)).min(1).max(16).optional(),
  startTimeMs: z.number().int().min(0).optional(),
  endTimeMs: z.number().int().min(0).optional(),
});

function resourceReadInput(
  principal: { readonly userId: string; readonly catId: string },
  threadId: string,
  data: z.infer<typeof readSchema>,
): MeetingArtifactReadInput {
  return {
    ownerId: principal.userId,
    threadId,
    catId: principal.catId,
    resourceRef: data.resourceRef,
    view: data.view,
    maxChars: data.maxChars,
    maxTokens: data.maxTokens,
    ...(data.cursor ? { cursor: data.cursor } : {}),
    ...(data.speakers ? { speakers: data.speakers } : {}),
    ...(data.startTimeMs === undefined ? {} : { startTimeMs: data.startTimeMs }),
    ...(data.endTimeMs === undefined ? {} : { endTimeMs: data.endTimeMs }),
  };
}

function resourceErrorStatus(code: MeetingArtifactResourceError['code']): 400 | 403 | 404 | 409 {
  if (code === 'RESOURCE_NOT_FOUND') return 404;
  if (code === 'RESOURCE_FORBIDDEN') return 403;
  if (code === 'RESOURCE_REVISION_MISMATCH' || code === 'SOURCE_REVISION_CHANGED') return 409;
  return 400;
}

async function readMeetingArtifact(
  reader: Pick<MeetingArtifactResourceService, 'read'>,
  input: MeetingArtifactReadInput,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    return await reader.read(input);
  } catch (error) {
    if (error instanceof MeetingArtifactResourceError) {
      return reply.status(resourceErrorStatus(error.code)).send({ error: error.message, code: error.code });
    }
    request.log.warn({ err: error }, 'meeting artifact source resolution failed');
    return reply.status(503).send({ error: 'Meeting artifact source is temporarily unavailable' });
  }
}

export function registerCallbackMeetingArtifactRoutes(
  app: FastifyInstance,
  options: CallbackMeetingArtifactRoutesOptions,
): void {
  app.post('/api/callbacks/meeting-artifacts/read', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = readSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid meeting artifact read request', details: parsed.error.issues });
    }
    const reader = options.readerHolder.current;
    if (!reader) return reply.status(503).send({ error: 'Meeting artifact reader is unavailable' });
    const thread = await resolvePrincipalThread(principal, parsed.data.threadId, {
      threadStore: options.threadStore,
      accessDeniedError: 'Meeting artifact thread access denied',
    });
    if (!thread.ok) return reply.status(thread.statusCode).send({ error: thread.error });
    return readMeetingArtifact(reader, resourceReadInput(principal, thread.threadId, parsed.data), request, reply);
  });
}
