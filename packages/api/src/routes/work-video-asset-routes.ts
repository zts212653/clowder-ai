import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WorkVideoContextService } from '../domains/collaborative-content/works/video-context.js';
import type { VideoProjectAssetIndex } from '../domains/video-studio/project/asset-index.js';
import { WorkspaceContentSourceError } from '../domains/workspace/workspace-content-source.js';
import { WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { replyArtifactReviewError } from './artifact-review-route-errors.js';
import { directContentHuman } from './content-modification-routes.js';
import { parseMediaByteRange } from './media-byte-range.js';

const paramsSchema = z
  .object({
    contentRef: z.string().min(1).max(2048),
    ownerRevision: z.coerce.number().int().positive().safe(),
    metadataRevision: z.coerce.number().int().positive().safe(),
    assetId: z.string().min(1).max(256),
  })
  .strict();
const sourceStatuses: Readonly<Record<string, number>> = {
  revision_changed: 409,
  too_large: 413,
  not_found: 404,
  access_denied: 403,
};
function failAsset(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceContentSourceError)
    return reply.code(sourceStatuses[error.code] ?? 400).send({ error: error.code });
  if (error instanceof WorkspaceSecurityError) {
    const missing = error.code === 'NOT_FOUND';
    return reply.code(missing ? 404 : 403).send({ error: missing ? 'not_found' : 'access_denied' });
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    return reply.code(404).send({ error: 'not_found' });
  return replyArtifactReviewError(reply, error);
}

type OpenAsset = Awaited<ReturnType<VideoProjectAssetIndex['open']>>;
async function sendAsset(request: FastifyRequest, reply: FastifyReply, opened: OpenAsset) {
  const range = request.headers.range ? parseMediaByteRange(request.headers.range, opened.byteLength) : null;
  if (request.headers.range && !range) {
    await opened.handle.close();
    await opened.cleanup();
    return reply.code(416).header('Content-Range', `bytes */${opened.byteLength}`).send();
  }
  const stream = opened.handle.createReadStream({ ...(range ?? {}), highWaterMark: 256 * 1024 });
  stream.once('close', () => {
    void opened.cleanup().catch(() => undefined);
  });
  // Active HTML/SVG/source scripts are downloads, never same-origin documents.
  const inline = /^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm)|audio\/(?:mpeg|mp4|wav|ogg))$/.test(
    opened.mediaType,
  );
  reply
    .header('Content-Type', inline ? opened.mediaType : 'application/octet-stream')
    .header('Content-Disposition', inline ? 'inline' : 'attachment')
    .header('Accept-Ranges', 'bytes');
  if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${opened.byteLength}`);
  return reply.header('Content-Length', range ? range.end - range.start + 1 : opened.byteLength).send(stream);
}

/** Read-only Phase A index: current work + root authority and immutable per-request bytes. */
export function registerWorkVideoAssetRoutes(
  app: FastifyInstance,
  deps: { contexts: WorkVideoContextService; assets: VideoProjectAssetIndex },
) {
  app.get('/api/works/:contentRef/video-assets/:ownerRevision/:metadataRevision/:assetId', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const params = paramsSchema.parse(request.params);
      const { threadId } = z
        .object({ threadId: z.string().min(1).max(256) })
        .strict()
        .parse(request.query);
      const principal = { ...human, threadId },
        reference = { contentRef: params.contentRef, ownerRevision: params.ownerRevision };
      const metadata = await deps.contexts.read(reference, principal, params.metadataRevision);
      const asset = metadata?.context.assets.find((row) => row.asset.id === params.assetId);
      const version = asset?.asset.versions.find((row) => row.id === asset.versionId);
      if (!version) return reply.code(404).send({ error: 'asset_not_indexed' });
      const opened = await deps.assets.open(version);
      try {
        await deps.contexts.read(reference, principal, params.metadataRevision);
        return await sendAsset(request, reply, opened);
      } catch (error) {
        await opened.handle.close();
        await opened.cleanup();
        throw error;
      }
    } catch (error) {
      return failAsset(reply, error);
    }
  });
}
