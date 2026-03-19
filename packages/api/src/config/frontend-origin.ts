/**
 * Frontend URL/origin resolution shared by screenshot export and CORS setup.
 */

export interface WarnLoggerLike {
  warn: (...args: unknown[]) => void;
}

const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3003';
const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:3003', 'https://cafe.clowder-ai.com'];

/**
 * Match origins from private networks (RFC 1918 + Tailscale CGNAT 100.64/10 + loopback).
 * Safe to auto-accept: these IPs never appear on the public internet.
 */
const PRIVATE_NETWORK_ORIGIN =
  /^https?:\/\/(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|127\.\d+\.\d+\.\d+)(:\d+)?$/;

function normalizeConfiguredUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return rawUrl.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeConfiguredOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseFrontendPort(rawPort: string | undefined): number | null {
  const trimmed = rawPort?.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return port;
}

export function resolveFrontendBaseUrl(env: NodeJS.ProcessEnv, logger?: WarnLoggerLike): string {
  const rawFrontendUrl = env.FRONTEND_URL?.trim();
  if (rawFrontendUrl) {
    const normalizedUrl = normalizeConfiguredUrl(rawFrontendUrl);
    if (normalizedUrl) {
      return normalizedUrl;
    }
    logger?.warn(
      { frontendUrl: rawFrontendUrl },
      '[thread-export] Invalid FRONTEND_URL, fallback to FRONTEND_PORT/default',
    );
  }

  const rawFrontendPort = env.FRONTEND_PORT;
  const frontendPort = parseFrontendPort(rawFrontendPort);
  if (frontendPort !== null) {
    return `http://localhost:${frontendPort}`;
  }

  if (rawFrontendPort?.trim()) {
    logger?.warn(
      { frontendPort: rawFrontendPort },
      '[thread-export] Invalid FRONTEND_PORT, fallback to localhost:3003',
    );
  }

  return DEFAULT_FRONTEND_BASE_URL;
}

export function resolveFrontendCorsOrigins(env: NodeJS.ProcessEnv, logger?: WarnLoggerLike): (string | RegExp)[] {
  const origins = new Set<string>(DEFAULT_CORS_ORIGINS);

  const rawFrontendUrl = env.FRONTEND_URL?.trim();
  if (rawFrontendUrl) {
    const normalizedOrigin = normalizeConfiguredOrigin(rawFrontendUrl);
    if (normalizedOrigin) {
      origins.add(normalizedOrigin);
    } else {
      logger?.warn({ frontendUrl: rawFrontendUrl }, '[cors] Invalid FRONTEND_URL, ignored custom origin');
    }
  }

  const rawFrontendPort = env.FRONTEND_PORT;
  const frontendPort = parseFrontendPort(rawFrontendPort);
  if (frontendPort !== null) {
    origins.add(`http://localhost:${frontendPort}`);
  } else if (rawFrontendPort?.trim()) {
    logger?.warn({ frontendPort: rawFrontendPort }, '[cors] Invalid FRONTEND_PORT, fallback to default origins');
  }

  const result: (string | RegExp)[] = [...origins];
  // Auto-accept private/Tailscale networks (safe for home/dev environments)
  result.push(PRIVATE_NETWORK_ORIGIN);
  return result;
}
