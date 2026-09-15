import { createHash } from 'node:crypto';
import {
  type EvolutionPreparationMediaRequestV1,
  type EvolutionPreparationMediaV1,
  type EvolutionPreparationReviewRequestV1,
  type EvolutionPreparationReviewV1,
  evolutionPreparationReviewV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PROGRAM_ADAPTER_MEDIA_MAX_BYTES } from '../infrastructure/capability-evolution/adapters/program-adapter-media-contract.js';
import type {
  ProgramAdapter,
  ProgramAdapterRegistry,
} from '../infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import { requireContext } from './capability-evolution-program-context.js';
import { programIdSchema } from './capability-evolution-program-schemas.js';

interface Options {
  service?: Pick<EvolutionProgramService, 'get'>;
  adapterRegistry?: ProgramAdapterRegistry;
  unavailable(reply: FastifyReply): unknown;
  sendError(error: unknown, reply: FastifyReply): unknown;
}
const query = z.object({}).strict();
const mediaParams = z.object({ programId: programIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
function missing(
  input: EvolutionPreparationReviewRequestV1,
  status: 'unknown' | 'unavailable',
  code: string,
): EvolutionPreparationReviewV1 {
  return { schemaVersion: 1, ...input, status, blockers: [{ code, ownerRef: input.objectRef }] };
}

interface OwnerPreparationReadResult {
  outcome: 'readable' | 'unavailable' | 'invalid';
  code: 200 | 422 | 503;
  body: EvolutionPreparationReviewV1;
}

async function readOwner(
  input: EvolutionPreparationReviewRequestV1,
  reader: NonNullable<ProgramAdapter['preparationReview']>,
): Promise<OwnerPreparationReadResult> {
  let raw: unknown;
  try {
    raw = await reader(input);
  } catch {
    return { outcome: 'unavailable', code: 503, body: missing(input, 'unavailable', 'owner_preparation_read_failed') };
  }
  const parsed = evolutionPreparationReviewV1Schema.safeParse(raw);
  if (!parsed.success)
    return { outcome: 'invalid', code: 422, body: missing(input, 'unavailable', 'owner_preparation_invalid') };
  const result = parsed.data;
  if (
    refIdentity(result.programRef) !== refIdentity(input.programRef) ||
    refIdentity(result.objectRef) !== refIdentity(input.objectRef)
  )
    return {
      outcome: 'invalid',
      code: 422,
      body: missing(input, 'unavailable', 'owner_preparation_identity_mismatch'),
    };
  if (result.status === 'unknown' || result.status === 'unavailable')
    return { outcome: 'unavailable', code: 422, body: result };
  return { outcome: 'readable', code: 200, body: result };
}

/** Only the authenticated Program supplies identity. Reading never calls an execution verb. */
export function createCapabilityEvolutionPreparationReviewHandler(options: Options) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    const context = requireContext(request, reply);
    if (!context) return;
    if (!options.service) return options.unavailable(reply);
    try {
      const id = programIdSchema.parse((request.params as { programId: string }).programId);
      query.parse(request.query);
      const projection = await options.service.get(id);
      if (projection.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const input: EvolutionPreparationReviewRequestV1 = {
        programRef: { ownerFeatureId: 'F311', ownerStateRef: id },
        objectRef: projection.program.objectRef,
      };
      const resolution = options.adapterRegistry?.resolve(input.objectRef);
      if (resolution?.status !== 'resolved' || !resolution.adapter.preparationReview)
        return reply.status(422).send(missing(input, 'unknown', 'owner_preparation_reader_missing'));
      const result = await readOwner(input, resolution.adapter.preparationReview.bind(resolution.adapter));
      return reply.status(result.code).send(result.body);
    } catch (error) {
      return options.sendError(error, reply);
    }
  };
}

function publishedMedia(review: EvolutionPreparationReviewV1, sha256: string) {
  if (review.status !== 'resolved') return undefined;
  return review.groups
    .flatMap((group) => group.items)
    .flatMap((item) => item.resources)
    .find(
      (resource) =>
        resource.media?.mediaRef.version === sha256 &&
        resource.media.mediaRef.ownerStateRef.endsWith(`:sha256:${sha256}`),
    )?.media;
}

function resolvedMedia(
  value: unknown,
  input: EvolutionPreparationMediaRequestV1,
  contentType: 'video/mp4' | 'video/webm',
) {
  if (typeof value !== 'object' || value === null) return undefined;
  const result = value as {
    status?: unknown;
    mediaRef?: unknown;
    kind?: unknown;
    contentType?: unknown;
    bytes?: unknown;
  };
  if (
    result.status !== 'resolved' ||
    result.kind !== 'video' ||
    result.contentType !== contentType ||
    !(result.bytes instanceof Uint8Array) ||
    result.bytes.byteLength === 0 ||
    result.bytes.byteLength > PROGRAM_ADAPTER_MEDIA_MAX_BYTES
  )
    return undefined;
  const mediaRef = input.mediaRef;
  const returnedRef = ownerTruthRefV1Schema.safeParse(result.mediaRef);
  if (
    !returnedRef.success ||
    refIdentity(returnedRef.data) !== refIdentity(mediaRef) ||
    createHash('sha256').update(result.bytes).digest('hex') !== mediaRef.version
  )
    return undefined;
  return { bytes: result.bytes, contentType };
}

type PreparationMediaError = { status: 'error'; statusCode: 404 | 422 | 503; error: string };
type LocatedPreparationMedia =
  | {
      status: 'resolved';
      reader: NonNullable<ProgramAdapter['preparationMedia']>;
      media: EvolutionPreparationMediaV1;
    }
  | PreparationMediaError;

function declaredPreparationMediaFailure(value: unknown): PreparationMediaError | undefined {
  if (typeof value !== 'object') return undefined;
  if (value === null) return undefined;
  const result = value as { status?: unknown; code?: unknown };
  if (result.status === 'unavailable')
    return { status: 'error', statusCode: 503, error: 'owner_preparation_media_unavailable' };
  if (result.status === 'blocked')
    return result.code === 'preparation_media_unavailable'
      ? { status: 'error', statusCode: 503, error: 'owner_preparation_media_unavailable' }
      : { status: 'error', statusCode: 422, error: 'owner_preparation_media_invalid' };
  if (result.status === 'not_found') return { status: 'error', statusCode: 404, error: 'not_found' };
  if (result.status === 'invalid')
    return { status: 'error', statusCode: 422, error: 'owner_preparation_media_invalid' };
  return undefined;
}

async function locatePreparationMedia(
  registry: ProgramAdapterRegistry | undefined,
  input: EvolutionPreparationReviewRequestV1,
  sha256: string,
): Promise<LocatedPreparationMedia> {
  if (!registry) return { status: 'error', statusCode: 503, error: 'owner_preparation_unavailable' };
  const resolution = registry.resolve(input.objectRef);
  if (resolution.status !== 'resolved') return { status: 'error', statusCode: 404, error: 'not_found' };
  const publicationReader = resolution.adapter.preparationReview;
  if (!publicationReader) return { status: 'error', statusCode: 503, error: 'owner_preparation_unavailable' };
  const publication = await readOwner(input, publicationReader.bind(resolution.adapter));
  if (publication.outcome === 'unavailable')
    return { status: 'error', statusCode: 503, error: 'owner_preparation_unavailable' };
  if (publication.outcome === 'invalid')
    return { status: 'error', statusCode: 422, error: 'owner_preparation_invalid' };
  const media = publishedMedia(publication.body, sha256);
  if (!media) return { status: 'error', statusCode: 404, error: 'not_found' };
  const reader = resolution.adapter.preparationMedia;
  return reader
    ? { status: 'resolved', reader: reader.bind(resolution.adapter), media }
    : { status: 'error', statusCode: 503, error: 'owner_preparation_media_unavailable' };
}

async function preparationMediaProjection(
  registry: ProgramAdapterRegistry | undefined,
  input: EvolutionPreparationReviewRequestV1,
  sha256: string,
) {
  const located = await locatePreparationMedia(registry, input, sha256);
  if (located.status === 'error') return located;
  const mediaInput: EvolutionPreparationMediaRequestV1 = { ...input, mediaRef: located.media.mediaRef };
  let raw: unknown;
  try {
    raw = await located.reader(mediaInput);
  } catch {
    return { status: 'error' as const, statusCode: 503 as const, error: 'owner_preparation_media_unavailable' };
  }
  const declaredFailure = declaredPreparationMediaFailure(raw);
  if (declaredFailure) return declaredFailure;
  const result = resolvedMedia(raw, mediaInput, located.media.contentType);
  return result
    ? { status: 'resolved' as const, ...result }
    : { status: 'error' as const, statusCode: 422 as const, error: 'owner_preparation_media_invalid' };
}

/** Re-reads current owner publication before resolving an exact content-addressed video. */
export function createCapabilityEvolutionPreparationMediaHandler(options: Options) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    const context = requireContext(request, reply);
    if (!context) return;
    if (!options.service) return options.unavailable(reply);
    try {
      const params = mediaParams.parse(request.params);
      query.parse(request.query);
      const projection = await options.service.get(params.programId);
      if (projection.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const input = {
        programRef: { ownerFeatureId: 'F311', ownerStateRef: params.programId },
        objectRef: projection.program.objectRef,
      };
      const result = await preparationMediaProjection(options.adapterRegistry, input, params.sha256);
      if (result.status === 'error') return reply.status(result.statusCode).send({ error: result.error });
      return reply.header('X-Content-Type-Options', 'nosniff').type(result.contentType).send(Buffer.from(result.bytes));
    } catch (error) {
      return options.sendError(error, reply);
    }
  };
}
