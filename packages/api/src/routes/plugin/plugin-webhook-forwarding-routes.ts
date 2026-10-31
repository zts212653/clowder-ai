import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { withoutPluginCallContext } from '../../domains/plugin/carrier/plugin-call-context.js';
import { withPluginOwnerRequest } from '../../domains/plugin/carrier/plugin-owner-request-context.js';
import type { DeclaredPluginWebhook } from '../../domains/plugin/declared/declared-runtime-contributions.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from '../plugin-access-guards.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_HEADERS = 32;
const MAX_RESPONSE_HEADER_VALUE_BYTES = 8 * 1024;
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-agent-key-secret',
  'x-api-key',
  'x-callback-token',
  'x-cat-cafe-user',
  'x-cat-id',
  'x-csrf-token',
  'x-invocation-id',
]);
const ALLOWED_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'content-length',
  'content-range',
  'cache-control',
  'content-language',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'x-content-type-options',
]);

export interface PluginWebhookForwardingPort {
  resolvePluginWebhook(pluginId: string, path: string, method?: string): DeclaredPluginWebhook | undefined;
  callPluginWebhook(
    pluginId: string,
    contributionId: string,
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface PluginWebhookForwardingRoutesOptions {
  readonly webhooks: PluginWebhookForwardingPort;
  readonly timeoutMs?: number;
}

interface ForwardingParams {
  readonly pluginId: string;
  readonly '*': string;
}

/** One Host-owned route for every active package-declared webhook. */
export const pluginWebhookForwardingRoutes: FastifyPluginAsync<PluginWebhookForwardingRoutesOptions> = async (
  app,
  options,
) => {
  installRawBodyParsers(app);

  app.all<{ Params: ForwardingParams }>('/api/plugins/:pluginId/*', (request, reply) =>
    forwardPluginWebhook(request, reply, options),
  );
};

async function forwardPluginWebhook(
  request: FastifyRequest<{ Params: ForwardingParams }>,
  reply: FastifyReply,
  options: PluginWebhookForwardingRoutesOptions,
): Promise<unknown> {
  const target = resolveTarget(request, options.webhooks);
  if (!target.ok) {
    if (target.allow) reply.header('allow', target.allow);
    return reply.status(target.status).send({ error: target.error });
  }
  const principal = authorizeRequest(request, reply, target.declared, target.method);
  // Await the response already started by authorization, including async onSend hooks.
  if (principal === false) return reply;

  const requestIdentity = captureOwnerHttpRequest(request, target);
  const lifetime = requestLifetime(request, reply);
  let returnedBody: Readable | undefined;
  let failurePhase: 'invocation' | 'validation' = 'invocation';
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    const invoke = () =>
      withTimeout(
        options.webhooks.callPluginWebhook(request.params.pluginId, target.declared.contributionId, {
          method: target.method,
          path: target.path,
          query: structuredClone(request.query as Record<string, unknown>),
          body: request.body,
          rawBody: rawBodyFor(request),
          headers: forwardedHeaders(request),
          ...(principal === undefined ? {} : { principal }),
        }),
        timeoutMs,
      );
    const value = await withoutPluginCallContext(() =>
      principal === undefined
        ? invoke()
        : withPluginOwnerRequest(
            {
              pluginId: request.params.pluginId,
              contributionId: target.declared.contributionId,
              userId: principal.id,
              operation: target.method === 'GET' ? 'read' : 'write',
              signal: lifetime.signal,
              requestIdentity,
            },
            invoke,
          ),
    );
    if (value && typeof value === 'object' && 'body' in value && value.body instanceof Readable)
      returnedBody = value.body;
    failurePhase = 'validation';
    return await sendPluginResponse(reply, validatePluginResponse(value));
  } catch (error) {
    returnedBody?.destroy();
    if (error instanceof PluginWebhookTimeoutError) {
      request.log.warn(
        {
          pluginId: request.params.pluginId,
          contributionId: target.declared.contributionId,
        },
        'Plugin webhook timed out',
      );
      return reply.status(504).send({ error: 'Plugin webhook timed out' });
    }
    if (failurePhase === 'validation') {
      request.log.warn(
        {
          pluginId: request.params.pluginId,
          contributionId: target.declared.contributionId,
          validationError: validationErrorMessage(error),
        },
        'Plugin webhook returned an invalid response',
      );
    } else {
      request.log.warn(
        {
          pluginId: request.params.pluginId,
          contributionId: target.declared.contributionId,
        },
        'Plugin webhook invocation failed',
      );
    }
    return reply.status(502).send({ error: 'Plugin webhook returned an invalid response' });
  } finally {
    lifetime.close();
  }
}

function captureOwnerHttpRequest(request: FastifyRequest, target: Extract<ResolvedTarget, { ok: true }>) {
  // Capture trusted route facts and original bytes before any package handler can mutate its input.
  // This ID identifies one authenticated HTTP request, not a cross-request retry contract.
  const rawUrl = request.raw.url ?? '';
  const queryStart = rawUrl.indexOf('?');
  return {
    requestId: randomUUID(),
    transportRequestId: request.id,
    method: target.method,
    declaredPath: target.declared.path,
    path: target.path,
    bodyDigest: createHash('sha256').update(rawBodyFor(request)).digest('hex'),
    queryDigest: createHash('sha256')
      .update(queryStart < 0 ? '' : rawUrl.slice(queryStart + 1))
      .digest('hex'),
  };
}

function requestLifetime(request: FastifyRequest, reply: FastifyReply): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once('aborted', abort);
  reply.raw.once('close', abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  return {
    signal: controller.signal,
    close: () => {
      controller.abort();
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    },
  };
}

type ResolvedTarget =
  | {
      readonly ok: true;
      readonly path: string;
      readonly method: string;
      readonly declared: DeclaredPluginWebhook;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 405;
      readonly error: string;
      readonly allow?: string;
    };

function resolveTarget(
  request: FastifyRequest<{ Params: ForwardingParams }>,
  webhooks: PluginWebhookForwardingPort,
): ResolvedTarget {
  const rawPath = request.raw.url?.split('?', 1)[0] ?? '';
  const prefix = `/api/plugins/${request.params.pluginId}/`;
  // Use raw bytes: Fastify decodes wildcard params and would turn an encoded
  // identifier slash into a route separator. Encoded plugin-id aliases fail closed.
  if (!rawPath.startsWith(prefix)) return { ok: false, status: 404, error: 'Webhook path not found' };
  const path = rawPath.slice(prefix.length);
  const method = request.method.toUpperCase();
  const declared = webhooks.resolvePluginWebhook(request.params.pluginId, path, method);
  if (!declared) return { ok: false, status: 404, error: 'Webhook path not found' };
  if (!declared.methods.includes(method as (typeof declared.methods)[number])) {
    return {
      ok: false,
      status: 405,
      error: 'Webhook method not allowed',
      allow: declared.methods.join(', '),
    };
  }
  return { ok: true, path, method, declared };
}

function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  declared: DeclaredPluginWebhook,
  method: string,
): { kind: 'owner'; id: string } | undefined | false {
  if (declared.anonymous) return undefined;
  const access = requirePluginOwnerLocalAccess(request, method === 'GET' ? 'read' : 'write');
  if ('error' in access) {
    reply.send(pluginAccessError(reply, access));
    return false;
  }
  return { kind: 'owner', id: access.operator };
}

function sendPluginResponse(reply: FastifyReply, response: PluginWebhookResponse): unknown {
  reply.status(response.status);
  for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
  return reply.send(response.body);
}

function installRawBodyParsers(app: FastifyInstance): void {
  const parseJson = (request: unknown, body: Buffer, done: (error: Error | null, value?: unknown) => void) => {
    rememberRawBody(request, body);
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error as Error);
    }
  };
  const parseText = (request: unknown, body: Buffer, done: (error: Error | null, value?: unknown) => void) => {
    rememberRawBody(request, body);
    done(null, body.toString('utf8'));
  };
  const parseBuffer = (request: unknown, body: Buffer, done: (error: Error | null, value?: unknown) => void) => {
    rememberRawBody(request, body);
    done(null, body);
  };
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, parseJson);
  app.addContentTypeParser(['application/xml', 'text/xml', 'text/plain'], { parseAs: 'buffer' }, parseText);
  app.addContentTypeParser('*', { parseAs: 'buffer' }, parseBuffer);
}

function rememberRawBody(request: unknown, body: Buffer): void {
  (request as { rawBody?: Buffer }).rawBody = Buffer.from(body);
}

function rawBodyFor(request: FastifyRequest): Buffer {
  return Buffer.from((request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0));
}

function forwardedHeaders(request: FastifyRequest): Record<string, string | readonly string[]> {
  const result: Record<string, string | readonly string[]> = {};
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    result[name] = Array.isArray(value) ? [...value] : String(value);
  }
  return result;
}

interface PluginWebhookResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function validatePluginResponse(value: unknown): PluginWebhookResponse {
  if (!isPlainRecord(value)) throw new TypeError('response must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'status' && key !== 'headers' && key !== 'body')) {
    throw new TypeError('response contains unknown fields');
  }
  const status = value.status;
  if (!Number.isSafeInteger(status) || (status as number) < 200 || (status as number) > 599) {
    throw new TypeError('response status is invalid');
  }
  const headers = validateResponseHeaders(value.headers);
  const body = validateResponseBody(value.body);
  return { status: status as number, headers, body };
}

function validateResponseHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainRecord(value) || Object.keys(value).length > MAX_RESPONSE_HEADERS) {
    throw new TypeError('response headers are invalid');
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_RESPONSE_HEADERS.has(name) || typeof rawValue !== 'string') {
      throw new TypeError(`response header ${rawName} is not allowed`);
    }
    if (Buffer.byteLength(rawValue) > MAX_RESPONSE_HEADER_VALUE_BYTES || /[\r\n]/.test(rawValue)) {
      throw new TypeError(`response header ${rawName} is invalid`);
    }
    if (name === 'location' && !isSameOriginRelativeLocation(rawValue)) {
      throw new TypeError('response location must be same-origin and relative');
    }
    if (name === 'content-length' && (!/^(0|[1-9][0-9]*)$/.test(rawValue) || !Number.isSafeInteger(Number(rawValue))))
      throw new TypeError('response content-length is invalid');
    if (name === 'accept-ranges' && rawValue !== 'bytes' && rawValue !== 'none')
      throw new TypeError('response accept-ranges is invalid');
    if (name === 'content-range' && !/^bytes (?:[0-9]+-[0-9]+|\*)\/[0-9]+$/.test(rawValue))
      throw new TypeError('response content-range is invalid');
    headers[name] = rawValue;
  }
  return headers;
}

function validateResponseBody(value: unknown): unknown {
  if (value instanceof Readable) return value;
  if (value === undefined) return undefined;
  if (Buffer.isBuffer(value)) {
    if (value.byteLength > MAX_RESPONSE_BODY_BYTES) throw new TypeError('response body is too large');
    return value;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_RESPONSE_BODY_BYTES) throw new TypeError('response body is too large');
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_RESPONSE_BODY_BYTES) throw new TypeError('response body is too large');
    return value;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError('response body must be JSON serializable');
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RESPONSE_BODY_BYTES) {
    throw new TypeError('response body is invalid or too large');
  }
  return value;
}

function isSameOriginRelativeLocation(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  try {
    return new URL(value, 'http://plugin-host.invalid').origin === 'http://plugin-host.invalid';
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'unknown validation failure').slice(0, 512);
}

class PluginWebhookTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PluginWebhookTimeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
