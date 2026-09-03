import {
  type CollectiveEventEnvelope,
  type CollectiveTarget,
  collectiveEventEnvelopeSchema,
  collectiveTargetSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const verifiedAgentSchema = z
  .object({
    agentId: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(120),
    catId: z.string().trim().min(1).max(120),
    sessionRef: z.string().trim().min(1).max(240),
  })
  .strict();

const outboxItemSchema = z
  .object({
    outboxId: z.string(),
    clientEventId: z.string(),
    agent: verifiedAgentSchema,
    target: collectiveTargetSchema,
    replyToEventId: z.string().optional(),
    body: z.string(),
    status: z.enum(['queued', 'sending', 'accepted']),
    acceptedEventId: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

const routeReceiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_echo') }).strict(),
  z.object({ kind: z.literal('not_local') }).strict(),
  z
    .object({
      kind: z.literal('thread_message'),
      threadId: z.string(),
      messageId: z.string(),
      catId: z.string().optional(),
    })
    .strict(),
]);

const routeFailureSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

const inboxItemSchema = z
  .object({
    event: collectiveEventEnvelopeSchema,
    disposition: z.enum(['persisted', 'routing', 'routed', 'route_failed']),
    persistedAt: z.string().datetime(),
    routeConfigRevision: z.number().int().positive().optional(),
    routeAttemptedAt: z.string().datetime().optional(),
    routedAt: z.string().datetime().optional(),
    routeReceipt: routeReceiptSchema.optional(),
    routeFailure: routeFailureSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.disposition === 'routed' && (!item.routedAt || !item.routeReceipt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routeReceipt'],
        message: 'Routed inbox events require one durable Host receipt',
      });
    }
    if (item.disposition === 'route_failed' && !item.routeFailure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routeFailure'],
        message: 'Failed inbox routing requires one explicit failure',
      });
    }
  });

const agentHostRouteSchema = z
  .object({
    catId: z.string().trim().min(1).max(120),
    threadId: z.string().trim().min(1).max(240),
  })
  .strict();

export const hostRouteConfigSchema = z
  .object({
    connectionId: z.string(),
    localOwnerUserId: z.string().trim().min(1).max(240),
    defaultIngressThreadId: z.string().trim().min(1).max(240),
    humanNotificationThreadId: z.string().trim().min(1).max(240),
    agentRoutes: z.record(z.string(), agentHostRouteSchema),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const setHostRouteInputSchema = hostRouteConfigSchema.omit({
  connectionId: true,
  revision: true,
  updatedAt: true,
});

const connectionSchema = z
  .object({
    serviceUrl: z.string().url(),
    clientBuildId: z.string().trim().min(1).max(120),
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    connectionId: z.string(),
    endpointId: z.string(),
    authorizedHumanId: z.string().optional(),
    endpointLabel: z.string(),
    endpointCredential: z.string().optional(),
    authorityStatus: z.enum(['connected', 'revoking', 'revoked']),
    revocationReason: z.enum(['owner_revoked', 'identity_rebind_required']).optional(),
    liveStatus: z.enum(['online', 'offline']),
    lastAckedSequence: z.number().int().nonnegative(),
    pendingAckSequence: z.number().int().positive().optional(),
    outbox: z.array(outboxItemSchema),
    inbox: z.array(inboxItemSchema),
    createdAt: z.string().datetime(),
    lastError: z.string().optional(),
    lastErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.authorityStatus !== 'revoked' && (!connection.authorizedHumanId || !connection.endpointCredential)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorizedHumanId'],
        message: 'Active endpoint authority must be bound to one Human and one credential',
      });
    }
    if (connection.authorityStatus === 'revoked' && !connection.revocationReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revocationReason'],
        message: 'Revoked endpoint authority requires a reason',
      });
    }
  });

const legacyConnectionRecordSchema = z
  .object({
    connectionId: z.string(),
    reason: z.literal('identity_rebind_required'),
    migratedAt: z.string().datetime(),
    state: z.unknown(),
  })
  .strict();

const connectorStateV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    connections: z.record(z.string(), connectionSchema),
    legacyConnections: z.array(legacyConnectionRecordSchema),
    hostRoutes: z.record(z.string(), hostRouteConfigSchema).default({}),
  })
  .strict();

const legacyConnectionSchema = z
  .object({
    serviceUrl: z.string().url(),
    clientBuildId: z.string().trim().min(1).max(120),
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    connectionId: z.string(),
    endpointId: z.string(),
    endpointLabel: z.string(),
    authorityStatus: z.enum(['connected', 'revoking', 'revoked']),
    liveStatus: z.enum(['online', 'offline']),
    lastAckedSequence: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .passthrough();

const connectorStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    connections: z.record(z.string(), legacyConnectionSchema),
  })
  .strict();

export type VerifiedAgent = z.infer<typeof verifiedAgentSchema>;

export interface ConnectorOutboxItem {
  readonly outboxId: string;
  readonly clientEventId: string;
  readonly agent: VerifiedAgent;
  readonly target: CollectiveTarget;
  readonly replyToEventId?: string;
  readonly body: string;
  readonly status: 'queued' | 'sending' | 'accepted';
  readonly acceptedEventId?: string;
  readonly createdAt: string;
}

export interface ConnectorInboxItem {
  readonly event: CollectiveEventEnvelope;
  readonly disposition: 'persisted' | 'routing' | 'routed' | 'route_failed';
  readonly persistedAt: string;
  readonly routeConfigRevision?: number;
  readonly routeAttemptedAt?: string;
  readonly routedAt?: string;
  readonly routeReceipt?: ConnectorRouteReceipt;
  readonly routeFailure?: ConnectorRouteFailure;
}

export type ConnectorRouteReceipt =
  | { readonly kind: 'local_echo' }
  | { readonly kind: 'not_local' }
  | {
      readonly kind: 'thread_message';
      readonly threadId: string;
      readonly messageId: string;
      readonly catId?: string;
    };

export interface ConnectorRouteFailure {
  readonly code: string;
  readonly message: string;
}

export interface AgentHostRoute {
  readonly catId: string;
  readonly threadId: string;
}

export interface HostRouteConfig {
  readonly connectionId: string;
  readonly localOwnerUserId: string;
  readonly defaultIngressThreadId: string;
  readonly humanNotificationThreadId: string;
  readonly agentRoutes: Readonly<Record<string, AgentHostRoute>>;
  readonly revision: number;
  readonly updatedAt: string;
}

export type SetHostRouteInput = Omit<HostRouteConfig, 'connectionId' | 'revision' | 'updatedAt'>;

export interface ConnectorConnectionState {
  readonly serviceUrl: string;
  readonly clientBuildId: string;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly endpointId: string;
  readonly authorizedHumanId?: string;
  readonly endpointLabel: string;
  readonly endpointCredential?: string;
  readonly authorityStatus: 'connected' | 'revoking' | 'revoked';
  readonly revocationReason?: 'owner_revoked' | 'identity_rebind_required';
  readonly liveStatus: 'online' | 'offline';
  readonly lastAckedSequence: number;
  readonly pendingAckSequence?: number;
  readonly outbox: ConnectorOutboxItem[];
  readonly inbox: ConnectorInboxItem[];
  readonly createdAt: string;
  readonly lastError?: string;
  readonly lastErrorCode?: string;
}

export interface LegacyConnectorConnectionRecord {
  readonly connectionId: string;
  readonly reason: 'identity_rebind_required';
  readonly migratedAt: string;
  readonly state: unknown;
}

export interface ConnectorState {
  readonly schemaVersion: 2;
  readonly connections: Record<string, ConnectorConnectionState>;
  readonly legacyConnections: LegacyConnectorConnectionRecord[];
  readonly hostRoutes: Record<string, HostRouteConfig>;
}

export type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

export type MutableConnectorState = DeepMutable<ConnectorState>;

export function parseConnectorState(value: unknown): ConnectorState {
  return connectorStateV2Schema.parse(value) as ConnectorState;
}

export function migrateConnectorState(value: unknown, migratedAt = new Date().toISOString()): ConnectorState {
  const version = schemaVersionOf(value);
  if (version === 2) return parseConnectorState(value);
  if (version !== 1) throw new Error(`Unsupported Collective Connector state schema version: ${String(version)}`);

  const legacy = connectorStateV1Schema.parse(value);
  const connections: Record<string, ConnectorConnectionState> = {};
  const legacyConnections: LegacyConnectorConnectionRecord[] = [];
  for (const [connectionId, connection] of Object.entries(legacy.connections)) {
    const sanitized = structuredClone(connection) as Record<string, unknown>;
    delete sanitized.endpointCredential;
    legacyConnections.push({
      connectionId,
      reason: 'identity_rebind_required',
      migratedAt,
      state: sanitized,
    });
    connections[connectionId] = {
      serviceUrl: connection.serviceUrl,
      clientBuildId: connection.clientBuildId,
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
      endpointLabel: connection.endpointLabel,
      authorityStatus: 'revoked',
      revocationReason: 'identity_rebind_required',
      liveStatus: 'offline',
      lastAckedSequence: connection.lastAckedSequence,
      outbox: [],
      inbox: [],
      createdAt: connection.createdAt,
      lastError: 'This connection predates Human-bound authority and must be paired again.',
      lastErrorCode: 'IDENTITY_REBIND_REQUIRED',
    };
  }
  return parseConnectorState({ schemaVersion: 2, connections, legacyConnections, hostRoutes: {} });
}

function schemaVersionOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return undefined;
  return value.schemaVersion;
}
