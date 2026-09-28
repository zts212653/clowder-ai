import {
  type CollectiveAgentMessageRequest,
  type CollectiveEventEnvelope,
  type CollectivePairingIntent,
  type CollectiveParticipationDeclaration,
  type CollectiveSourceIdentity,
  collectiveEventEnvelopeSchema,
  collectiveParticipationDeclarationSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const connectionResponseSchema = z
  .object({
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    connectionId: z.string(),
    endpointId: z.string(),
    authorizedHumanId: z.string(),
    endpointCredential: z.string().min(20),
  })
  .strict();

const metadataResponseSchema = z
  .object({
    serviceInstanceId: z.string(),
    clientBuildId: z.string().trim().min(1).max(120),
  })
  .passthrough();

const pollResponseSchema = z
  .object({
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    connectionId: z.string(),
    lastAckedSequence: z.number().int().nonnegative(),
    events: z.array(collectiveEventEnvelopeSchema),
  })
  .strict();

export type ServiceConnectionResponse = z.infer<typeof connectionResponseSchema>;
export type ServicePollResponse = z.infer<typeof pollResponseSchema>;

export class ConnectorTransportError extends Error {
  get code(): string {
    return this.causeCode ?? 'COLLECTIVE_SERVICE_UNAVAILABLE';
  }
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = 'ConnectorTransportError';
  }
}

export class CollectiveServiceClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async readMetadata(serviceUrl: string): Promise<{ serviceInstanceId: string; clientBuildId: string }> {
    const parsed = metadataResponseSchema.safeParse(await this.request(serviceUrl, '/api/meta'));
    if (!parsed.success) throw new ConnectorTransportError('Service metadata is invalid');
    return {
      serviceInstanceId: parsed.data.serviceInstanceId,
      clientBuildId: parsed.data.clientBuildId,
    };
  }

  async exchangePairing(
    serviceUrl: string,
    intent: CollectivePairingIntent,
    endpointLabel: string,
  ): Promise<ServiceConnectionResponse> {
    const payload = await this.request(serviceUrl, '/api/connections/exchange', {
      method: 'POST',
      headers: { Origin: intent.hostOrigin },
      body: {
        serviceInstanceId: intent.serviceInstanceId,
        collectiveId: intent.collectiveId,
        pairingIntentId: intent.pairingIntentId,
        hostOrigin: intent.hostOrigin,
        nonce: intent.nonce,
        endpointLabel,
      },
    });
    return connectionResponseSchema.parse(payload);
  }

  async postAgentMessage(
    serviceUrl: string,
    endpointCredential: string,
    input: CollectiveAgentMessageRequest,
  ): Promise<CollectiveEventEnvelope> {
    const payload = await this.request(serviceUrl, '/api/events/agent', {
      method: 'POST',
      credential: endpointCredential,
      body: input,
    });
    return collectiveEventEnvelopeSchema.parse(payload);
  }

  async poll(
    serviceUrl: string,
    endpointCredential: string,
    input: {
      serviceInstanceId: string;
      collectiveId: string;
      connectionId: string;
      afterSequence: number;
      limit: number;
    },
  ): Promise<ServicePollResponse> {
    const query = new URLSearchParams({
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      connectionId: input.connectionId,
      afterSequence: String(input.afterSequence),
      limit: String(input.limit),
    });
    const payload = await this.request(serviceUrl, `/api/events/endpoint?${query}`, {
      credential: endpointCredential,
    });
    return pollResponseSchema.parse(payload);
  }

  async acknowledge(
    serviceUrl: string,
    endpointCredential: string,
    input: {
      serviceInstanceId: string;
      collectiveId: string;
      connectionId: string;
      sequence: number;
    },
  ): Promise<void> {
    await this.request(serviceUrl, '/api/acks', {
      method: 'POST',
      credential: endpointCredential,
      body: input,
    });
  }

  async publishParticipation(serviceUrl: string, credential: string, declaration: CollectiveParticipationDeclaration) {
    const payload = await this.request(serviceUrl, '/api/participation', {
      method: 'POST',
      credential,
      body: declaration,
    });
    // The receipt also carries publishedAt. Do not trust an acknowledgement for another revision.
    const parsed = collectiveParticipationDeclarationSchema.safeParse(
      Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'publishedAt')),
    );
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(declaration))
      throw new ConnectorTransportError('Participation receipt does not match');
    return parsed.data;
  }

  async readParticipationDeclaration(
    serviceUrl: string,
    credential: string,
    coordinates: Pick<CollectiveParticipationDeclaration, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    const payload = await this.request(serviceUrl, `/api/participation?${new URLSearchParams(coordinates)}`, {
      credential,
    });
    return z.object({ declaration: collectiveParticipationDeclarationSchema.nullable() }).strict().parse(payload)
      .declaration;
  }

  async readParticipationContext(
    serviceUrl: string,
    credential: string,
    source: CollectiveSourceIdentity,
    afterSequence = 0,
    limit = 30,
  ) {
    const payload = await this.request(serviceUrl, '/api/participation/context', {
      method: 'POST',
      credential,
      body: {
        serviceInstanceId: source.serviceInstanceId,
        collectiveId: source.collectiveId,
        connectionId: source.connectionId,
        catId: source.catId,
        participationRevision: source.participationRevision,
        eventId: source.eventId,
        afterSequence,
        limit,
      },
    });
    return z
      .object({
        source: collectiveEventEnvelopeSchema,
        events: z.array(collectiveEventEnvelopeSchema).max(100),
        nextCursor: z.number().int().positive().optional(),
      })
      .strict()
      .parse(payload);
  }

  async revoke(
    serviceUrl: string,
    endpointCredential: string,
    coordinates: {
      serviceInstanceId: string;
      collectiveId: string;
      connectionId: string;
    },
  ): Promise<void> {
    await this.request(serviceUrl, '/api/connections/self-revoke', {
      method: 'POST',
      credential: endpointCredential,
      body: coordinates,
    });
  }

  private async request(
    serviceUrl: string,
    path: string,
    options: {
      method?: 'GET' | 'POST';
      credential?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${new URL(serviceUrl).origin}${path}`, {
        method: options.method ?? 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
          ...options.headers,
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (cause) {
      throw new ConnectorTransportError('Collective Service is unreachable', undefined, transportErrorCode(cause));
    }
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const message = errorMessage(payload) ?? `Collective Service returned HTTP ${response.status}`;
      const code =
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        payload.error &&
        typeof payload.error === 'object' &&
        'code' in payload.error &&
        typeof payload.error.code === 'string'
          ? payload.error.code
          : undefined;
      throw new ConnectorTransportError(message, response.status, code);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ConnectorTransportError('Collective Service returned an invalid response');
    }
    return payload as Record<string, unknown>;
  }
}

function transportErrorCode(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    if ('code' in current && typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function errorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object' || !('message' in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}
