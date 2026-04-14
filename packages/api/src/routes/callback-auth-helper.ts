import type { FastifyRequest } from 'fastify';
import type { InvocationRecord, InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

export const INVALID_CALLBACK_CREDENTIALS_ERROR = {
  error: 'INVALID_CALLBACK_CREDENTIALS',
  message: EXPIRED_CREDENTIALS_ERROR.error,
  hint: EXPIRED_CREDENTIALS_ERROR.hint,
} as const;

export const STALE_INVOCATION_ERROR = {
  error: 'STALE_INVOCATION',
  message: 'Invocation has been superseded by a newer invocation for this thread and cat',
} as const;

type CredentialSource = 'body' | 'query' | 'headers';

type ExtractedCredentials =
  | {
      found: false;
      source: null;
      invocationId: null;
      callbackToken: null;
    }
  | {
      found: true;
      source: CredentialSource;
      invocationId: unknown;
      callbackToken: unknown;
    };

export type OptionalCallbackAuthResult =
  | {
      ok: true;
      record: InvocationRecord | null;
      invocationId: string | null;
      source: CredentialSource | null;
    }
  | {
      ok: false;
      statusCode: number;
      body: unknown;
    };

export interface ResolveOptionalCallbackAuthOptions {
  requireLatest?: boolean;
  invalidStatusCode?: number;
  invalidBody?: unknown;
  staleStatusCode?: number;
  staleBody?: unknown;
}

function firstValue(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  return value;
}

function hasCredentialKeys(source: unknown): boolean {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const obj = source as Record<string, unknown>;
  return Object.hasOwn(obj, 'invocationId') || Object.hasOwn(obj, 'callbackToken');
}

function extractCredentials(request: FastifyRequest): ExtractedCredentials {
  const body = request.body;
  if (hasCredentialKeys(body)) {
    const obj = body as Record<string, unknown>;
    return {
      found: true,
      source: 'body',
      invocationId: firstValue(obj.invocationId),
      callbackToken: firstValue(obj.callbackToken),
    };
  }

  const query = request.query;
  if (hasCredentialKeys(query)) {
    const obj = query as Record<string, unknown>;
    return {
      found: true,
      source: 'query',
      invocationId: firstValue(obj.invocationId),
      callbackToken: firstValue(obj.callbackToken),
    };
  }

  const hasHeaderCreds =
    request.headers['x-invocation-id'] !== undefined || request.headers['x-callback-token'] !== undefined;
  if (hasHeaderCreds) {
    return {
      found: true,
      source: 'headers',
      invocationId: firstValue(request.headers['x-invocation-id']),
      callbackToken: firstValue(request.headers['x-callback-token']),
    };
  }

  return {
    found: false,
    source: null,
    invocationId: null,
    callbackToken: null,
  };
}

/**
 * Resolve optional callback authentication from request body/query/headers.
 * - No credentials present: returns record=null (panel path)
 * - Credentials present: validates pair, verifies registry, optional stale guard
 */
export function resolveOptionalCallbackAuth(
  request: FastifyRequest,
  registry?: InvocationRegistry,
  options?: ResolveOptionalCallbackAuthOptions,
): OptionalCallbackAuthResult {
  if (!registry) {
    return { ok: true, record: null, invocationId: null, source: null };
  }

  const extracted = extractCredentials(request);
  if (!extracted.found) {
    return { ok: true, record: null, invocationId: null, source: null };
  }

  const invalidStatusCode = options?.invalidStatusCode ?? 401;
  const invalidBody = options?.invalidBody ?? INVALID_CALLBACK_CREDENTIALS_ERROR;
  const staleStatusCode = options?.staleStatusCode ?? 409;
  const staleBody = options?.staleBody ?? STALE_INVOCATION_ERROR;

  const parsed = callbackAuthSchema.safeParse({
    invocationId: extracted.invocationId,
    callbackToken: extracted.callbackToken,
  });
  if (!parsed.success) {
    return { ok: false, statusCode: invalidStatusCode, body: invalidBody };
  }

  const { invocationId, callbackToken } = parsed.data;
  const record = registry.verify(invocationId, callbackToken);
  if (!record) {
    return { ok: false, statusCode: invalidStatusCode, body: invalidBody };
  }

  if (options?.requireLatest === true && !registry.isLatest(invocationId)) {
    return { ok: false, statusCode: staleStatusCode, body: staleBody };
  }

  return { ok: true, record, invocationId, source: extracted.source };
}
