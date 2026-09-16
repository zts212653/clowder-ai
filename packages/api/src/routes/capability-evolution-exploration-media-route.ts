import { createHash } from 'node:crypto';
import {
  type EvolutionExplorationMediaReadV1,
  type EvolutionExplorationMediaRequestV1,
  type EvolutionExplorationMediaV1,
  evolutionExplorationMediaReadV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PROGRAM_ADAPTER_MEDIA_MAX_BYTES } from '../infrastructure/capability-evolution/adapters/program-adapter-media-contract.js';
import { readExplorationOwner } from '../infrastructure/capability-evolution/read-model/program-exploration.js';
import {
  type EvolutionExplorationRouteOptions,
  encodedExplorationRefSchema,
  resolveExplorationProgram,
} from './capability-evolution-exploration-routes.js';

const querySchema = z
  .object({ experimentRef: encodedExplorationRefSchema, recordRef: encodedExplorationRefSchema })
  .strict();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

function matchesPublishedMedia(
  value: Extract<EvolutionExplorationMediaReadV1, { status: 'resolved' }>,
  media: EvolutionExplorationMediaV1,
) {
  return (
    refIdentity(value.mediaRef) === refIdentity(media.mediaRef) &&
    value.kind === media.kind &&
    value.contentType === media.contentType &&
    value.bytes.byteLength <= PROGRAM_ADAPTER_MEDIA_MAX_BYTES &&
    createHash('sha256').update(value.bytes).digest('hex') === media.mediaRef.version
  );
}
const failureStatus = { unavailable: 503, invalid: 422, not_found: 404 } as const;

/** Exact publication lookup before lazy byte access; callers never supply a file path or remote URL. */
export function createCapabilityEvolutionExplorationMediaHandler(options: EvolutionExplorationRouteOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolved = await resolveExplorationProgram(options, request, reply);
      if (!resolved) return;
      const sha256 = sha256Schema.parse((request.params as { sha256: string }).sha256);
      const { experimentRef, recordRef } = querySchema.parse(request.query);
      const result = await readExplorationOwner(resolved.adapter, {
        ...resolved.input,
        selectedExperimentRef: experimentRef,
      });
      if (result.body.status !== 'resolved') return reply.status(result.code).send(result.body);
      const detail = result.body.details.find((item) => refIdentity(item.experimentRef) === refIdentity(experimentRef));
      if (detail && detail.status !== 'resolved')
        return reply.status(failureStatus[detail.status]).send({ error: `exploration_record_${detail.status}` });
      const record =
        detail?.status === 'resolved'
          ? detail.records.find((item) => refIdentity(item.recordRef) === refIdentity(recordRef))
          : undefined;
      const media = record?.media.find((item) => item.mediaRef.version === sha256);
      if (record?.mediaStatus)
        return reply
          .status(failureStatus[record.mediaStatus.status])
          .send({ error: `exploration_media_${record.mediaStatus.status}` });
      if (!media) return reply.status(404).send({ error: 'not_found' });
      if (!resolved.adapter.explorationMedia) return reply.status(503).send({ error: 'exploration_media_unavailable' });
      const input: EvolutionExplorationMediaRequestV1 = {
        ...resolved.input,
        experimentRef,
        recordRef,
        mediaRef: media.mediaRef,
      };
      let raw: unknown;
      try {
        raw = await resolved.adapter.explorationMedia(input);
      } catch {
        return reply.status(503).send({ error: 'exploration_media_unavailable' });
      }
      const parsed = evolutionExplorationMediaReadV1Schema.safeParse(raw);
      if (!parsed.success) return reply.status(422).send({ error: 'exploration_media_protocol_invalid' });
      const read = parsed.data;
      if (read.status !== 'resolved')
        return reply.status(failureStatus[read.status]).send({ error: `exploration_media_${read.status}` });
      if (!matchesPublishedMedia(read, media)) return reply.status(422).send({ error: 'exploration_media_invalid' });
      return reply.header('X-Content-Type-Options', 'nosniff').type(media.contentType).send(Buffer.from(read.bytes));
    } catch (error) {
      return options.sendError(error, reply);
    }
  };
}
