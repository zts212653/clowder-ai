import type { IncomingMessage, ServerResponse } from 'node:http';

import { CollectiveServiceError } from './errors.js';
import type { BeginHumanAuthIntent } from './identity-store.js';

const HUMAN_AUTH_COMPLETION_COOKIE = 'collective_auth_completion';
const HUMAN_AUTH_COMPLETION_COOKIE_PATH = '/api/auth/completions/exchange';

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1_024) {
      throw new CollectiveServiceError('FORBIDDEN', 'Request body is too large', 413);
    }
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CollectiveServiceError('FORBIDDEN', 'JSON object body is required', 400);
  }
  return parsed as Record<string, unknown>;
}

export function requireBearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new CollectiveServiceError('AUTHENTICATION_REQUIRED', 'Bearer credential required', 401);
  }
  return authorization.slice(7);
}

export function optionalBearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  return requireBearer(request);
}

export function requireHumanAuthCompletionCookie(request: IncomingMessage): string {
  const value = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${HUMAN_AUTH_COMPLETION_COOKIE}=`))
    ?.slice(HUMAN_AUTH_COMPLETION_COOKIE.length + 1);
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new CollectiveServiceError('AUTH_COMPLETION_INVALID', 'Human auth completion is invalid', 401);
  }
  return value;
}

export function setHumanAuthCompletionCookie(response: ServerResponse, token: string, secure: boolean): void {
  response.setHeader(
    'set-cookie',
    `${HUMAN_AUTH_COMPLETION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${HUMAN_AUTH_COMPLETION_COOKIE_PATH}; Max-Age=300${secure ? '; Secure' : ''}`,
  );
}

export function clearHumanAuthCompletionCookie(response: ServerResponse, secure: boolean): void {
  response.setHeader(
    'set-cookie',
    `${HUMAN_AUTH_COMPLETION_COOKIE}=; HttpOnly; SameSite=Strict; Path=${HUMAN_AUTH_COMPLETION_COOKIE_PATH}; Max-Age=0${secure ? '; Secure' : ''}`,
  );
}

export function parseHumanAuthIntent(body: Record<string, unknown>): BeginHumanAuthIntent {
  const kind = requiredString(body, 'intent');
  if (kind === 'bind' || kind === 'login') return { kind };
  if (kind === 'accept_invite') return { kind, inviteToken: requiredString(body, 'inviteToken') };
  throw new CollectiveServiceError('FORBIDDEN', 'intent is invalid', 400);
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) {
    throw new CollectiveServiceError('FORBIDDEN', `${key} is required`, 400);
  }
  return value;
}

export function requireFields<const Keys extends readonly string[]>(
  body: Record<string, unknown>,
  keys: Keys,
): { [Key in Keys[number]]: string } {
  return Object.fromEntries(keys.map((key) => [key, requiredString(body, key)])) as {
    [Key in Keys[number]]: string;
  };
}

export function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new CollectiveServiceError('FORBIDDEN', `${key} is required`, 400);
  return value;
}

export function numberQuery(url: URL, key: string, fallback: number): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CollectiveServiceError('FORBIDDEN', `${key} must be an integer`, 400);
  }
  return parsed;
}

export function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function requireAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): asserts origin is string {
  if (!origin || !allowedOrigins.has(origin)) forbiddenOrigin();
}

export function forbiddenOrigin(): never {
  throw new CollectiveServiceError('FORBIDDEN', 'Host origin is not allowed', 403);
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.writeHead(status).end(`${JSON.stringify(value)}\n`);
}

export function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof CollectiveServiceError) {
    writeJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof SyntaxError ? 'Malformed JSON' : 'Internal Service error';
  writeJson(response, error instanceof SyntaxError ? 400 : 500, {
    error: { code: error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL', message },
  });
}

export function applySecurityHeaders(response: ServerResponse, allowedOrigins: ReadonlySet<string>): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  const frameAncestors = ["'self'", ...allowedOrigins].join(' ');
  response.setHeader(
    'content-security-policy',
    `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors ${frameAncestors}`,
  );
  response.setHeader('cache-control', 'no-store');
}
