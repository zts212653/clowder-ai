/**
 * Frontend URL/origin resolution shared by screenshot export and CORS setup.
 */

export interface WarnLoggerLike {
  warn: (...args: unknown[]) => void;
}

const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3003';
const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:3003', 'https://cafe.clowder-ai.com'];

/**
 * F156: Loopback (127.x.x.x) is ALWAYS allowed — it is genuinely local.
 * Separated from RFC 1918 private networks because the threat model is different:
 * an evil website's JS runs in the same loopback context, but its Origin header
 * will be `https://evil.example`, not `http://127.0.0.1:*`. So loopback Origin
 * is safe to auto-accept.
 */
export const LOOPBACK_ORIGIN = /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?$/;

/**
 * Match origins from private networks (RFC 1918 + Tailscale CGNAT 100.64/10).
 * F156: Only included when CORS_ALLOW_PRIVATE_NETWORK=true.
 * These ARE a trust boundary concern: a malicious page hosted on a LAN device
 * (router admin, NAS) would have a matching Origin and could connect.
 */
export const PRIVATE_NETWORK_ORIGIN =
  /^https?:\/\/(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(:\d+)?$/;

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
  // F156: Loopback is always safe — same machine, different from LAN.
  result.push(LOOPBACK_ORIGIN);
  // F156: RFC 1918 / Tailscale private networks only with explicit opt-in.
  if (env.CORS_ALLOW_PRIVATE_NETWORK === 'true') {
    result.push(PRIVATE_NETWORK_ORIGIN);
  }
  return result;
}

/**
 * F156: Check if a given origin is allowed by the origin list.
 * Used by Socket.IO `allowRequest` hook to guard WebSocket upgrades,
 * because Socket.IO's `cors` config does NOT protect WebSocket transport
 * (only HTTP long-polling). This is the real security boundary.
 *
 * Ref: Socket.IO docs "Handling CORS" (2026-02-16), OpenClaw ClawJacked.
 */
export function isOriginAllowed(origin: string, allowedOrigins: (string | RegExp)[]): boolean {
  return allowedOrigins.some((allowed) => (allowed instanceof RegExp ? allowed.test(origin) : allowed === origin));
}
