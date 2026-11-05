import { z } from 'zod';
import {
  collectiveArtifactAgentConstraintRequestSchema,
  collectiveArtifactConstraintRequestSchema,
  collectiveArtifactConstraintSchema,
} from './collective-artifact.js';

const id = z.string().trim().min(1).max(256);
const coordinates = { serviceInstanceId: id, collectiveId: id, connectionId: id };
export const collectiveArtifactRelayRequestSchema = collectiveArtifactConstraintRequestSchema
  .extend({
    requestId: id,
    payload: z.record(z.unknown()),
  })
  .strict();
export const collectiveArtifactAgentRelayRequestSchema = collectiveArtifactAgentConstraintRequestSchema
  .extend({
    requestId: id,
    payload: z.record(z.unknown()),
  })
  .strict();
export const collectiveArtifactRelayPollSchema = z.object(coordinates).strict();
export const collectiveArtifactRelayOperationSchema = z
  .object({
    relayRef: id,
    requestId: id,
    constraint: collectiveArtifactConstraintSchema,
    payload: z.record(z.unknown()),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type CollectiveArtifactRelayOperation = z.infer<typeof collectiveArtifactRelayOperationSchema>;
export const collectiveArtifactRelayResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...coordinates,
      relayRef: id,
      status: z.literal('ok'),
      ownerDecisionRef: id,
      value: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      ...coordinates,
      relayRef: id,
      status: z.literal('error'),
      error: z
        .object({
          code: z.enum([
            'access_denied',
            'conflict',
            'owner_unavailable',
            'invalid_request',
            'unsupported_operation',
            'unknown',
          ]),
        })
        .strict(),
    })
    .strict(),
]);
