import type { FastifyRequest } from 'fastify';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_ADDRS.has(address);
}

function normalizeHostName(rawHost: string): string | null {
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 1 ? trimmed.slice(1, end) : null;
  }

  if (trimmed === '::1') return trimmed;
  const colonCount = [...trimmed].filter((char) => char === ':').length;
  if (colonCount > 1) return trimmed;

  return trimmed.split(':')[0] ?? null;
}

function headerHostName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return normalizeHostName(value);
}

function originHostName(value: string): string | null {
  try {
    return normalizeHostName(new URL(value).host);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string | null): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function hasTrustedLocalOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return true;
  return isLoopbackHost(originHostName(value));
}

/** Standard proxy forwarding headers — if any are present, the peer-loopback
 *  address is the proxy, not the original client. */
const PROXY_FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
] as const;

function hasNonEmptyHeader(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.some((v) => v.trim().length > 0);
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Returns true when the request originates from a direct loopback peer
 * (not proxied). Use this for owner-gate loopback guards so that reverse-
 * proxy / Tailscale sidecar deployments don't bypass the guard.
 */
export function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.ip)) return false;
  return !PROXY_FORWARDING_HEADERS.some((h) => hasNonEmptyHeader(request.headers[h]));
}

export function isTrustedLocalApiRequest(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.ip)) return false;

  const host = headerHostName(request.headers.host);
  if (!isLoopbackHost(host)) return false;

  return hasTrustedLocalOrigin(request.headers.origin);
}
