import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { resolveFrontendCorsOrigins } from '../config/frontend-origin.js';

/** Loopback hostnames always allowed regardless of config */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface SecurityHeadersOptions {
  /** Override allowed origins (for testing). If omitted, resolved from env. */
  allowedOrigins?: (string | RegExp)[];
  /** API's own public base URL (for split-host deployments). */
  apiBaseUrl?: string;
}

/**
 * F156 D-6: Build Host allowlist from CORS origins + API base URL.
 * Extracts hostnames from string origins, always includes loopback.
 * Host header may include port — we match hostname part only.
 */
function buildAllowedHosts(origins: (string | RegExp)[], apiBaseUrl?: string): Set<string> {
  const hosts = new Set<string>(LOOPBACK_HOSTS);
  for (const origin of origins) {
    if (typeof origin !== 'string') continue;
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      // skip malformed origins
    }
  }
  // Split-host: API may live on a different domain than the frontend
  if (apiBaseUrl) {
    try {
      hosts.add(new URL(apiBaseUrl).hostname);
    } catch {
      // skip malformed URL
    }
  }
  return hosts;
}

function extractHostname(rawHost: string): string {
  // Strip port: "cafe.clowder-ai.com:443" → "cafe.clowder-ai.com"
  // Handle IPv6: "[::1]:3004" → "[::1]"
  if (rawHost.startsWith('[')) {
    const bracketEnd = rawHost.indexOf(']');
    return bracketEnd >= 0 ? rawHost.slice(0, bracketEnd + 1) : rawHost;
  }
  const colonIdx = rawHost.lastIndexOf(':');
  return colonIdx >= 0 ? rawHost.slice(0, colonIdx) : rawHost;
}

function securityHeaders(app: FastifyInstance, opts: SecurityHeadersOptions, done: () => void) {
  const origins = opts.allowedOrigins ?? resolveFrontendCorsOrigins(process.env);
  const apiUrl = opts.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL;
  const allowedHosts = buildAllowedHosts(origins, apiUrl);

  // F156 D-6: DNS Rebinding defense — validate Host header early
  app.addHook('onRequest', (request, reply, next) => {
    const rawHost = request.headers.host ?? '';
    const hostname = extractHostname(rawHost);
    if (!allowedHosts.has(hostname)) {
      reply.code(403).send({ error: 'Host not allowed' });
      return;
    }
    next();
  });

  // F156 D-2: Anti-Clickjacking headers
  app.addHook('onSend', (_request, reply, _payload, next) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });
  done();
}

export const securityHeadersPlugin = fp(securityHeaders, {
  name: 'security-headers',
});
