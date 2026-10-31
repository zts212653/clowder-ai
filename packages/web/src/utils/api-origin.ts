import { deploymentDefaults, resolveDirectApiPort } from '@cat-cafe/shared';

function getBrowserLocation(): Location | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const candidate = (globalThis as { location?: Location }).location;
  return candidate ?? null;
}

function isLoopbackLocation(location: Location | null): location is Location {
  return location != null && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

const LOOPBACK_API_ORIGIN = /^(https?:\/\/)(?:localhost|127\.0\.0\.1)(?=[:/]|$)/;

function alignLoopbackApiHostname(envUrl: string, location: Location | null): string {
  if (!isLoopbackLocation(location)) return envUrl;
  // SameSite=Strict session cookies require the page and local API to use the same hostname.
  return envUrl.replace(LOOPBACK_API_ORIGIN, `$1${location.hostname}`);
}

function localApiOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      (!url.port || Number(url.port) > 0) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function browserRuntimeOrigin(): unknown {
  if (typeof document === 'undefined') return undefined;
  // The opening <html> tag is parsed before any asynchronously loaded client module.
  return document.documentElement?.getAttribute('data-cat-cafe-api-origin');
}

function configuredApiOrigin(location: Location | null): string | null {
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!envUrl) return null;
  const isLocalhostDefault = LOOPBACK_API_ORIGIN.test(envUrl);
  const isLocalAccess = isLoopbackLocation(location);
  const isRemoteAccess = location != null && !isLocalAccess;
  // A compiled loopback address cannot route remote users; a cloud URL must not force a local tunnel trip.
  const mismatch = (isLocalhostDefault && isRemoteAccess) || (!isLocalhostDefault && isLocalAccess);
  return mismatch ? null : alignLoopbackApiHostname(envUrl, location);
}

function browserApiOrigin(location: Location | null): string | null {
  if (!isLoopbackLocation(location)) return null;
  const globals = globalThis as { desktopBridge?: { apiOrigin?: unknown } };
  const origin = localApiOrigin(globals.desktopBridge?.apiOrigin) ?? localApiOrigin(browserRuntimeOrigin());
  return origin ? alignLoopbackApiHostname(origin, location) : null;
}

/** Resolve once from the document's runtime identity, before client module initialization. */
export function resolveApiUrl(): string {
  const location = getBrowserLocation();
  const browserOrigin = browserApiOrigin(location);
  if (browserOrigin) return browserOrigin;
  // Server-side modules read the actual runtime port, independent of the packaged browser bundle.
  if (typeof window === 'undefined') {
    const port = Number(process.env.API_SERVER_PORT);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return `http://localhost:${port}`;
  }

  // Cloudflare Tunnel: API 走 api.clowder-ai.com，Access cookie 在 .clowder-ai.com 上共享
  if (location?.hostname === 'cafe.clowder-ai.com') {
    return 'https://api.clowder-ai.com';
  }
  const envUrl = configuredApiOrigin(location);
  if (envUrl) return envUrl;
  if (typeof window === 'undefined') return deploymentDefaults.apiBaseUrl;
  const protocol = location?.protocol ?? 'http:';
  const hostname = location?.hostname ?? 'localhost';
  const port = Number(location?.port ?? '') || 0;
  // Behind reverse proxy (default port 80/443 → port is empty string):
  // API lives at the same origin, proxied via /api/ and /socket.io/ paths.
  if (!port) return `${protocol}//${hostname}`;
  return `${protocol}//${hostname}:${resolveDirectApiPort(port, deploymentDefaults)}`;
}
