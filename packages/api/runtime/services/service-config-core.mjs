// Build-free primitives shared by the existing service owner and standalone clients.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const TTS_ENDPOINT = Object.freeze({
  id: 'mlx-tts',
  port: 9879,
  defaultEndpoint: 'http://localhost:9879',
  endpointEnvVars: ['TTS_URL'],
  portEnvKey: 'TTS_PORT',
});

export function resolveServiceConfigPath(repoRoot, env = process.env) {
  if (env.CAT_CAFE_SERVICES_CONFIG) return resolve(env.CAT_CAFE_SERVICES_CONFIG);
  let home = env.CAT_CAFE_HOME?.trim();
  if (home === '~') home = homedir();
  else if (home?.startsWith('~/')) home = resolve(homedir(), home.slice(2));
  return resolve(home || resolve(repoRoot, '.cat-cafe'), 'services.json');
}

export function readServiceConfigFile(configPath) {
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function normalizeLoopbackUrl(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.hostname !== 'localhost') return endpoint;
    const hadTrailingSlash = endpoint.endsWith('/');
    url.hostname = '127.0.0.1';
    const serialized = url.toString();
    return !hadTrailingSlash && url.pathname === '/' ? serialized.replace(/\/$/, '') : serialized;
  } catch {
    return endpoint;
  }
}

export function parseServicePort(value) {
  if (!value || !/^\d+$/.test(value)) return null;
  const port = Number.parseInt(value, 10);
  return port > 0 && port <= 65535 ? port : null;
}

export function resolveConfiguredServiceEndpoint(service, env, config, portEnvKey) {
  for (const key of service.endpointEnvVars) {
    const value = env[key]?.trim();
    if (value) return normalizeLoopbackUrl(value);
  }
  const configuredPort =
    typeof config?.port === 'number' && config.port > 0 && config.port <= 65535 ? config.port : null;
  const port = configuredPort ?? parseServicePort(portEnvKey ? env[portEnvKey]?.trim() : undefined);
  if (!port) return service.defaultEndpoint ? normalizeLoopbackUrl(service.defaultEndpoint) : null;
  if (service.portFallback) return `${service.portFallback.host.replace(/\/+$/, '')}:${port}`;
  if (!service.defaultEndpoint) return null;
  try {
    const url = new URL(service.defaultEndpoint);
    const hadTrailingSlash = service.defaultEndpoint.endsWith('/');
    url.port = String(port);
    const serialized = url.toString();
    return normalizeLoopbackUrl(!hadTrailingSlash && url.pathname === '/' ? serialized.replace(/\/$/, '') : serialized);
  } catch {
    return normalizeLoopbackUrl(service.defaultEndpoint.replace(/:\d+($|[/?#])/, `:${port}$1`));
  }
}
