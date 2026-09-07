import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PROGRAM_ADAPTER_MEDIA_CONTENT_TYPES,
  PROGRAM_ADAPTER_MEDIA_MAX_BYTES,
} from '../infrastructure/capability-evolution/adapters/program-adapter-media-contract.js';
import type { ProgramAdapterRegistry } from '../infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import { requireContext } from './capability-evolution-program-context.js';
import { programIdSchema } from './capability-evolution-program-schemas.js';

interface AdapterRouteOptions {
  service?: Pick<EvolutionProgramService, 'get'>;
  adapterRegistry?: ProgramAdapterRegistry;
  unavailable(reply: FastifyReply): unknown;
  sendError(error: unknown, reply: FastifyReply): unknown;
}

type AdapterScope = {
  programRef: OwnerTruthRefV1;
  cycleRef: OwnerTruthRefV1;
  objectRef: OwnerTruthRefV1;
  programSequence: number;
};

function scopeFor(
  programId: string,
  program: { objectRef: OwnerTruthRefV1; cycle: number; sequence: number },
): AdapterScope {
  return {
    programRef: { ownerFeatureId: 'F311', ownerStateRef: programId },
    cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${programId}:${program.cycle}` },
    objectRef: program.objectRef,
    programSequence: program.sequence,
  };
}

function isBlocked(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value as { status?: unknown }).status === 'blocked'
  );
}

async function manifestProjection(
  registry: ProgramAdapterRegistry | undefined,
  targetRef: OwnerTruthRefV1,
  input: AdapterScope,
): Promise<{ statusCode: 200 | 422 | 503; body: unknown }> {
  if (!registry) return { statusCode: 503, body: { error: 'program_adapter_registry_unavailable' } };
  const resolution = registry.resolve(targetRef);
  if (resolution.status === 'blocked') return { statusCode: 422, body: resolution };
  const manifest = resolution.adapter.manifest;
  if (typeof manifest !== 'function') {
    return { statusCode: 422, body: { status: 'blocked', code: 'owner_manifest_unavailable' } };
  }
  try {
    const body: unknown = await Reflect.apply(manifest, resolution.adapter, [input]);
    return { statusCode: isBlocked(body) ? 422 : 200, body };
  } catch {
    return { statusCode: 503, body: { status: 'blocked', code: 'owner_manifest_unavailable' } };
  }
}

type ResolvedMedia = { kind: 'image' | 'video'; contentType: string; bytes: Uint8Array };
type MediaResponse = { statusCode: 200; body: ResolvedMedia } | { statusCode: 422 | 503; body: unknown };

const MEDIA_CONTENT_TYPES = new Set<string>(PROGRAM_ADAPTER_MEDIA_CONTENT_TYPES);

function isResolvedMedia(value: unknown): value is ResolvedMedia {
  if (typeof value !== 'object' || value === null) return false;
  const media = value as { status?: unknown; kind?: unknown; contentType?: unknown; bytes?: unknown };
  return (
    media.status === 'resolved' &&
    (media.kind === 'image' || media.kind === 'video') &&
    typeof media.contentType === 'string' &&
    MEDIA_CONTENT_TYPES.has(media.contentType) &&
    media.bytes instanceof Uint8Array &&
    media.bytes.byteLength > 0 &&
    media.bytes.byteLength <= PROGRAM_ADAPTER_MEDIA_MAX_BYTES &&
    (media.kind === 'image' ? media.contentType.startsWith('image/') : media.contentType.startsWith('video/'))
  );
}

async function mediaProjection(
  registry: ProgramAdapterRegistry | undefined,
  targetRef: OwnerTruthRefV1,
  input: AdapterScope & { sceneIndex: number },
): Promise<MediaResponse> {
  if (!registry) return { statusCode: 503, body: { error: 'program_adapter_registry_unavailable' } };
  const resolution = registry.resolve(targetRef);
  if (resolution.status === 'blocked') return { statusCode: 422, body: resolution };
  const media = resolution.adapter.media;
  if (typeof media !== 'function') {
    return { statusCode: 422, body: { status: 'blocked', code: 'owner_media_unavailable' } };
  }
  try {
    const body: unknown = await Reflect.apply(media, resolution.adapter, [input]);
    if (isBlocked(body)) return { statusCode: 422, body };
    return isResolvedMedia(body)
      ? { statusCode: 200, body }
      : { statusCode: 422, body: { status: 'blocked', code: 'owner_media_unavailable' } };
  } catch {
    return { statusCode: 503, body: { status: 'blocked', code: 'owner_media_unavailable' } };
  }
}

export function createCapabilityEvolutionProgramAdapterHandlers(options: AdapterRouteOptions) {
  const adapterManifest = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!options.service) return options.unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await options.service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const result = await manifestProjection(
        options.adapterRegistry,
        current.program.objectRef,
        scopeFor(programId, current.program),
      );
      return reply.status(result.statusCode).send(result.body);
    } catch (error) {
      return options.sendError(error, reply);
    }
  };

  const adapterMedia = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!options.service) return options.unavailable(reply);
    try {
      const params = z
        .object({ programId: programIdSchema, sceneIndex: z.coerce.number().int().min(1).max(7) })
        .strict()
        .parse(request.params);
      const current = await options.service.get(params.programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const result = await mediaProjection(options.adapterRegistry, current.program.objectRef, {
        ...scopeFor(params.programId, current.program),
        sceneIndex: params.sceneIndex,
      });
      if (result.statusCode !== 200) return reply.status(result.statusCode).send(result.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .type(result.body.contentType)
        .send(Buffer.from(result.body.bytes));
    } catch (error) {
      return options.sendError(error, reply);
    }
  };

  return { adapterManifest, adapterMedia };
}
