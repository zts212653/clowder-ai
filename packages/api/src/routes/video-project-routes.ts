import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { probeImmutableMedia } from '../domains/video-studio/content-owner/published-media-probe.js';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
} from '../domains/video-studio/content-owner/service.js';
import {
  VideoProjectScreeningError,
  type VideoProjectScreeningService,
} from '../domains/video-studio/project/screening-service.js';
import type { VideoProjectService } from '../domains/video-studio/project/service.js';
import {
  WorkspaceContentSourceError,
  type WorkspaceContentSourceService,
} from '../domains/workspace/workspace-content-source.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { parseMediaByteRange } from './media-byte-range.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

const identity = z.string().min(1).max(512);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const registration = z
  .object({
    expectedOwnerRevision: z.number().int().positive().safe(),
    operationId: identity,
    id: identity,
    title: identity,
    input: z
      .object({ contentRef: identity, ownerRevision: z.number().int().positive().safe(), blobDigest: digest })
      .strict(),
    source: z
      .object({ locator: z.object({ worktreeId: identity, path: identity }).strict(), expectedSourceRevision: digest })
      .strict(),
    mapping: z.unknown(),
    refs: z.array(z.string().min(1).max(4096)).min(1).max(100),
  })
  .strict();
const coordinates = z.object({ contentRef: identity });
const screeningCoordinates = coordinates.extend({ screeningId: identity });

export interface VideoProjectRoutesOptions {
  projects: Pick<VideoProjectService, 'list' | 'load' | 'create' | 'readAsset' | 'operationReceipt'>;
  mediaSource: Pick<WorkspaceContentSourceService, 'describeMedia'>;
  screenings: VideoProjectScreeningService;
}

/** Browser facade: session Human identity only. Cat callback commands use separate authenticated composition. */
export const videoProjectRoutes: FastifyPluginAsync<VideoProjectRoutesOptions> = async (app, options) => {
  app.addHook('preHandler', async (request, reply) => {
    if (!isDirectLoopbackRequest(request) || !workspaceDirectHuman(request, resolveSessionUserId))
      return reply.code(401).send({ error: 'Authentication required' });
  });
  app.get('/api/video-projects', async (request, reply) =>
    respond(reply, async () => ({
      projects: await options.projects.list({ principal: principal(request) }),
    })),
  );
  app.post('/api/video-projects', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) =>
    respond(reply, async () => {
      const body = z.object({ operationId: identity, document: z.unknown() }).strict().parse(request.body);
      if (!Object.hasOwn(body, 'document')) throw new TypeError('Project document required');
      return options.projects.create({
        operationId: body.operationId,
        document: body.document,
        principal: principal(request),
      });
    }),
  );
  app.post('/api/video-projects/media-source', async (request, reply) =>
    respond(reply, async () => {
      const body = z
        .object({ locator: z.object({ worktreeId: identity, path: identity }).strict() })
        .strict()
        .parse(request.body);
      return options.mediaSource.describeMedia({ ...body, principal: { userId: principal(request).userId } });
    }),
  );
  app.get('/api/video-projects/:contentRef', async (request, reply) =>
    respond(reply, async () => {
      const { contentRef } = coordinates.parse(request.params);
      const query = z
        .object({ ownerRevision: z.coerce.number().int().positive().safe().optional() })
        .strict()
        .parse(request.query);
      return options.projects.load({
        contentRef,
        principal: principal(request),
        ...(query.ownerRevision ? { ownerRevision: query.ownerRevision } : {}),
      });
    }),
  );
  app.get('/api/video-projects/:contentRef/operations/:operationId', async (request, reply) =>
    respond(reply, async () => {
      const params = coordinates.extend({ operationId: identity }).parse(request.params);
      const receipt = await options.projects.operationReceipt({ ...params, principal: principal(request) });
      return { receipt: receipt ?? null };
    }),
  );
  app.get('/api/video-projects/:contentRef/assets/:assetVersionRef', async (request, reply) =>
    respond(reply, () => sendProjectAsset(request, reply, options.projects)),
  );
  app.post('/api/video-projects/:contentRef/screenings', async (request, reply) =>
    respond(reply, async () => {
      const { contentRef } = coordinates.parse(request.params);
      const body = registration.parse(request.body);
      return options.screenings.register({
        ...body,
        contentRef,
        principal: principal(request),
        input: { ...body.input, blobDigest: body.input.blobDigest as `sha256:${string}` },
        mapping: body.mapping as Parameters<VideoProjectScreeningService['register']>[0]['mapping'],
      });
    }),
  );
  app.get('/api/video-projects/:contentRef/screenings/:screeningId', async (request, reply) =>
    respond(reply, async () => {
      const { contentRef, screeningId } = screeningCoordinates.parse(request.params);
      return options.screenings.descriptor({ contentRef, screeningId, principal: principal(request) });
    }),
  );
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/video-projects/:contentRef/screenings/:screeningId/media',
    handler: async (request, reply) =>
      respond(reply, async () => {
        const { contentRef, screeningId } = screeningCoordinates.parse(request.params);
        const media = await options.screenings.open({
          contentRef,
          screeningId,
          principal: principal(request),
        });
        return sendScreeningMedia(request, reply, media);
      }),
  });
};

function principal(request: FastifyRequest) {
  const userId = workspaceDirectHuman(request, resolveSessionUserId);
  if (!userId) throw new VideoProjectScreeningError('access_denied');
  return { userId, actor: { kind: 'human' as const, actorId: userId } };
}

async function respond(reply: FastifyReply, callback: () => Promise<unknown>) {
  try {
    return await callback();
  } catch (error) {
    const failure = screeningHttpFailure(error);
    if (failure) return reply.code(failure.status).send(failure.body);
    throw error;
  }
}

function screeningHttpFailure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof TypeError)
    return { status: 400, body: { error: 'invalid_request' } };
  if (error instanceof ContentOwnerConflictError)
    return { status: 409, body: { error: error.code, actualOwnerRevision: error.actualOwnerRevision } };
  if (error instanceof ContentOwnerIdempotencyError) return { status: 409, body: { error: error.code } };
  if (error instanceof ContentOwnerNotFoundError) return { status: 404, body: { error: 'not_found' } };
  if (error instanceof VideoProjectScreeningError || error instanceof WorkspaceContentSourceError) {
    const statuses: Record<string, number> = {
      access_denied: 403,
      media_missing: 404,
      not_found: 404,
      screening_not_found: 404,
      invalid_screening: 400,
      unsupported_media: 400,
    };
    return { status: statuses[error.code] ?? 409, body: { error: error.code } };
  }
  if (error instanceof Error && /access denied/i.test(error.message))
    return { status: 403, body: { error: 'access_denied' } };
  return null;
}

async function sendScreeningMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  media: Awaited<ReturnType<VideoProjectScreeningService['open']>>,
) {
  reply
    .header('Content-Type', media.mediaType)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, no-store');
  try {
    const range = request.headers.range;
    const parsed = range ? parseMediaByteRange(range, media.byteLength) : undefined;
    if (range && !parsed) {
      await media.handle.close();
      return reply.code(416).header('Content-Range', `bytes */${media.byteLength}`).send();
    }
    if (parsed)
      reply
        .code(206)
        .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${media.byteLength}`)
        .header('Content-Length', parsed.end - parsed.start + 1);
    else reply.header('Content-Length', media.byteLength);
    if (request.method === 'HEAD') {
      await media.handle.close();
      return reply.send();
    }
    return reply.send(media.handle.createReadStream({ ...(parsed ?? {}), autoClose: true }));
  } catch (error) {
    await media.handle.close();
    throw error;
  }
}

async function validInlinePng(bytes: Buffer): Promise<boolean> {
  try {
    await probeImmutableMedia(bytes, 'image/png');
    return true;
  } catch {
    return false;
  }
}

async function sendProjectAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  projects: VideoProjectRoutesOptions['projects'],
) {
  const params = coordinates.extend({ assetVersionRef: identity }).parse(request.params);
  const query = z
    .object({ ownerRevision: z.coerce.number().int().positive().safe().optional() })
    .strict()
    .parse(request.query);
  const actor = principal(request);
  const snapshot = await projects.load({ ...params, principal: actor, ...query });
  const version = snapshot.document.assets
    .flatMap((asset) => asset.versions)
    .find((asset) => asset.id === params.assetVersionRef);
  if (!version) return reply.code(404).send({ error: 'asset_not_found' });
  if (version.mediaType.trim().toLowerCase().split(';')[0] !== 'image/png')
    return reply.code(415).send({ error: 'unsupported_inline_media' });
  const read = await projects.readAsset({
    ...params,
    ownerRevision: snapshot.ownerRevision,
    principal: actor,
  });
  if (read.state !== 'available')
    return reply.code(read.state === 'missing' ? 404 : 409).send({ error: `asset_${read.state}` });
  if (!(await validInlinePng(read.bytes))) return reply.code(409).send({ error: 'invalid_asset_image' });
  return reply
    .header('Content-Type', 'image/png')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .header('Content-Length', read.bytes.length)
    .send(read.bytes);
}
