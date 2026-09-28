import { z } from 'zod';
import {
  type CollectiveEventEnvelope,
  collectiveActorSchema,
  collectiveConnectionCoordinatesSchema,
  collectiveEndpointIdSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
} from './collective.js';

export const collectiveParticipantAgentSchema = z
  .object({
    catId: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(120),
    channelIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  })
  .strict();

export const collectiveParticipationDeclarationSchema = collectiveConnectionCoordinatesSchema
  .extend({
    revision: z.number().int().positive(),
    agents: z.array(collectiveParticipantAgentSchema).max(100),
  })
  .strict()
  .superRefine((declaration, ctx) => {
    if (new Set(declaration.agents.map((agent) => agent.catId)).size !== declaration.agents.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate participant' });
    }
  });

export const collectiveParticipantSchema = collectiveConnectionCoordinatesSchema
  .extend({
    endpointId: collectiveEndpointIdSchema,
    endpointLabel: z.string().min(1).max(160),
    humanId: collectiveHumanIdSchema,
    humanDisplayName: z.string().min(1).max(120),
    catId: z.string().min(1).max(120),
    displayName: z.string().min(1).max(120),
    channelIds: z.array(z.string()),
    participationRevision: z.number().int().positive(),
    availability: z.enum(['declared', 'revoked']),
  })
  .strict();

/** Stored on the source Message; it identifies an admitted public source, never owner authority. */
export const collectiveSourceIdentitySchema = collectiveConnectionCoordinatesSchema
  .extend({
    eventId: collectiveEventIdSchema,
    location: collectiveLocationSchema,
    catId: z.string().min(1).max(120),
    participationRevision: z.number().int().positive(),
    actor: collectiveActorSchema,
  })
  .strict();

export const collectiveExecutionGrantSchema = z
  .object({
    kind: z.literal('collective-participation'),
    originTriggerMessageId: z.string().min(1),
    source: collectiveSourceIdentitySchema,
  })
  .strict();

export type CollectiveParticipationDeclaration = z.infer<typeof collectiveParticipationDeclarationSchema>;
export type CollectiveParticipant = z.infer<typeof collectiveParticipantSchema>;
export type CollectiveSourceIdentity = z.infer<typeof collectiveSourceIdentitySchema>;
export type CollectiveExecutionGrant = z.infer<typeof collectiveExecutionGrantSchema>;

export function collectiveEventSourceIdentity(event: CollectiveEventEnvelope): CollectiveSourceIdentity | undefined {
  const recipient = event.recipient;
  if (!event.location || recipient?.kind !== 'agent') return undefined;
  return collectiveSourceIdentitySchema.parse({
    serviceInstanceId: event.serviceInstanceId,
    collectiveId: event.collectiveId,
    connectionId: recipient.connectionId,
    eventId: event.eventId,
    location: event.location,
    catId: recipient.agentId,
    participationRevision: recipient.participationRevision,
    actor: event.actor,
  });
}
