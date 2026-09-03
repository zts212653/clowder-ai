import { type CollectiveEventEnvelope, collectiveEventEnvelopeSchema } from '@cat-cafe/shared';
import { z } from 'zod';

import { CollectiveServiceError } from './errors.js';
import { humanAuthAttemptSchema, humanAuthBindingSchema, humanAuthCompletionSchema } from './human-auth-state.js';

export type { HumanAuthIntent } from './human-auth-state.js';

import type { ServiceState } from './service-records.js';

export type {
  CollectiveRecord,
  ConnectionRecord,
  DeepMutable,
  HumanRecord,
  InviteRecord,
  MembershipRecord,
  MutableServiceState,
  PairingIntentRecord,
  ServiceState,
  SessionRecord,
} from './service-records.js';

const humanSchema = z
  .object({
    humanId: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().url().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

const sessionSchema = z
  .object({
    sessionId: z.string(),
    humanId: z.string(),
    tokenDigest: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();

const collectiveSchema = z
  .object({
    collectiveId: z.string(),
    name: z.string(),
    createdByHumanId: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();

const membershipSchema = z
  .object({
    collectiveId: z.string(),
    humanId: z.string(),
    role: z.enum(['steward', 'member']),
    joinedAt: z.string().datetime(),
  })
  .strict();

const inviteSchema = z
  .object({
    inviteId: z.string(),
    collectiveId: z.string(),
    tokenDigest: z.string(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
  })
  .strict();

const pairingIntentSchema = z
  .object({
    pairingIntentId: z.string(),
    collectiveId: z.string(),
    createdByHumanId: z.string(),
    hostOrigin: z.string().url(),
    nonceDigest: z.string(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
  })
  .strict();

const connectionSchema = z
  .object({
    connectionId: z.string(),
    collectiveId: z.string(),
    endpointId: z.string(),
    endpointLabel: z.string(),
    credentialDigest: z.string(),
    authorizedHumanId: z.string().optional(),
    status: z.enum(['connected', 'revoked']),
    revocationReason: z.enum(['owner_revoked', 'self_revoked', 'identity_rebind_required']).optional(),
    lastDeliveredSequence: z.number().int().nonnegative().default(0),
    lastAckedSequence: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.status === 'connected' && !connection.authorizedHumanId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorizedHumanId'],
        message: 'Connected endpoint authority must be bound to one Human',
      });
    }
    if (connection.status === 'revoked' && (!connection.revokedAt || !connection.revocationReason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revokedAt'],
        message: 'Revoked endpoint authority requires a timestamp and reason',
      });
    }
  });

const bootstrapSchema = z
  .object({
    tokenDigest: z.string(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
    ownerHumanId: z.string().optional(),
  })
  .strict();

const serviceStateV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    serviceInstanceId: z.string(),
    createdAt: z.string().datetime(),
    bootstrap: bootstrapSchema,
    humans: z.record(z.string(), humanSchema),
    sessions: z.record(z.string(), sessionSchema),
    humanAuthBindings: z.record(z.string(), humanAuthBindingSchema),
    humanAuthAttempts: z.record(z.string(), humanAuthAttemptSchema),
    humanAuthCompletions: z.record(z.string(), humanAuthCompletionSchema),
    collectives: z.record(z.string(), collectiveSchema),
    memberships: z.record(z.string(), membershipSchema),
    invites: z.record(z.string(), inviteSchema),
    pairingIntents: z.record(z.string(), pairingIntentSchema),
    connections: z.record(z.string(), connectionSchema),
    events: z.record(z.string(), z.array(collectiveEventEnvelopeSchema)),
    legacyEvents: z.record(z.string(), z.array(z.unknown())),
    clientEventIndex: z.record(z.string(), z.string()),
  })
  .strict();

const serviceStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    serviceInstanceId: z.string(),
    createdAt: z.string().datetime(),
    bootstrap: bootstrapSchema,
    humans: z.record(z.string(), humanSchema),
    sessions: z.record(z.string(), sessionSchema),
    collectives: z.record(z.string(), collectiveSchema),
    memberships: z.record(z.string(), membershipSchema),
    invites: z.record(z.string(), inviteSchema),
    pairingIntents: z.record(z.string(), pairingIntentSchema),
    connections: z.record(
      z.string(),
      z
        .object({
          connectionId: z.string(),
          collectiveId: z.string(),
          endpointId: z.string(),
          endpointLabel: z.string(),
          credentialDigest: z.string(),
          status: z.enum(['connected', 'revoked']),
          lastDeliveredSequence: z.number().int().nonnegative().default(0),
          lastAckedSequence: z.number().int().nonnegative(),
          createdAt: z.string().datetime(),
          revokedAt: z.string().datetime().optional(),
        })
        .strict(),
    ),
    events: z.record(z.string(), z.array(z.unknown())),
    clientEventIndex: z.record(z.string(), z.string()),
  })
  .strict();

export function parseServiceState(value: unknown): ServiceState {
  return serviceStateV2Schema.parse(value) as ServiceState;
}

export function migrateServiceState(value: unknown): { readonly state: ServiceState; readonly migrated: boolean } {
  const version = readSchemaVersion(value);
  if (version === 2) return { state: parseServiceState(value), migrated: false };
  const legacy = serviceStateV1Schema.parse(value);
  const migratedEvents: Record<string, CollectiveEventEnvelope[]> = {};
  for (const [collectiveId, events] of Object.entries(legacy.events)) {
    const canonical: CollectiveEventEnvelope[] = [];
    const unmigratable: unknown[] = [];
    for (const event of events) {
      const migratedEvent = migrateLegacyEvent(event);
      if (migratedEvent) canonical.push(migratedEvent);
      else unmigratable.push(event);
    }
    if (unmigratable.length > 0) {
      throw new CollectiveServiceError(
        'STATE_MIGRATION_REQUIRED',
        `Collective ${collectiveId} contains ${unmigratable.length} legacy event(s) whose identity cannot be migrated without changing canonical order; repair or export the v1 state before upgrading`,
        409,
      );
    }
    migratedEvents[collectiveId] = canonical;
  }
  const migrated: ServiceState = {
    schemaVersion: 2,
    serviceInstanceId: legacy.serviceInstanceId,
    createdAt: legacy.createdAt,
    bootstrap: legacy.bootstrap,
    humans: legacy.humans,
    sessions: legacy.sessions,
    humanAuthBindings: {},
    humanAuthAttempts: {},
    humanAuthCompletions: {},
    collectives: legacy.collectives,
    memberships: legacy.memberships,
    invites: legacy.invites,
    pairingIntents: legacy.pairingIntents,
    connections: Object.fromEntries(
      Object.entries(legacy.connections).map(([connectionId, connection]) => [
        connectionId,
        {
          ...connection,
          status: 'revoked' as const,
          revokedAt: connection.revokedAt ?? connection.createdAt,
          revocationReason: 'identity_rebind_required' as const,
        },
      ]),
    ),
    events: migratedEvents,
    legacyEvents: {},
    clientEventIndex: rebuildClientEventIndex(migratedEvents),
  };
  return { state: parseServiceState(migrated), migrated: true };
}

export function membershipKey(collectiveId: string, humanId: string): string {
  return `${collectiveId}:${humanId}`;
}

function readSchemaVersion(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).schemaVersion;
  return typeof version === 'number' ? version : undefined;
}

function migrateLegacyEvent(value: unknown): CollectiveEventEnvelope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const actor = event.actor;
  const target = event.target;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return undefined;
  if ((actor as Record<string, unknown>).kind !== 'human') return undefined;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const targetRecord = target as Record<string, unknown>;
  const migratedTarget =
    targetRecord.kind === 'channel' && typeof targetRecord.id === 'string'
      ? { kind: 'channel' as const, channelId: targetRecord.id }
      : targetRecord.kind === 'message' && typeof targetRecord.id === 'string'
        ? { kind: 'message' as const, eventId: targetRecord.id }
        : undefined;
  if (!migratedTarget) return undefined;
  const parsed = collectiveEventEnvelopeSchema.safeParse({ ...event, actor, target: migratedTarget });
  return parsed.success ? parsed.data : undefined;
}

function rebuildClientEventIndex(events: Record<string, CollectiveEventEnvelope[]>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [collectiveId, collectiveEvents] of Object.entries(events)) {
    for (const event of collectiveEvents) {
      const actorScope =
        event.actor.kind === 'human'
          ? `human:${event.actor.humanId}`
          : `connection:${event.actor.provenance.connectionId}`;
      index[`${collectiveId}:${actorScope}:${event.clientEventId}`] = event.eventId;
    }
  }
  return index;
}
