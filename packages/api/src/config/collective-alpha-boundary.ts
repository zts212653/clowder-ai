import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NamedAlphaRuntimeBoundary } from './alpha-coordinates.js';

interface CollectiveAlphaScope {
  readonly env: NodeJS.ProcessEnv;
  readonly root?: string;
  readonly frontendOrigin: string;
  readonly dataDirectory: string;
  readonly serviceUrl: string;
  readonly cliPath: string;
  readonly namedAlpha?: NamedAlphaRuntimeBoundary;
}

export function isManagedCollectiveServiceRecord(value: unknown, serviceUrl: string): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).serviceUrl === serviceUrl
  );
}

export function validatedCollectiveBootstrapUrl(candidate: string, serviceUrl: string): string {
  const url = new URL(candidate);
  if (url.origin !== new URL(serviceUrl).origin || !new URLSearchParams(url.hash.slice(1)).get('bootstrap'))
    throw new Error('Invalid Collective bootstrap link');
  return url.href;
}

function isSymlinkOrUnreadable(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
}

export function isPinnedCollectiveAlpha(scope: CollectiveAlphaScope): boolean {
  const { env, root, frontendOrigin, dataDirectory, serviceUrl, cliPath, namedAlpha } = scope;
  if (
    !root ||
    env.CAT_CAFE_DEPLOYMENT_ID !== 'alpha' ||
    !env.CAT_CAFE_RUNTIME_ROOT ||
    resolve(env.CAT_CAFE_RUNTIME_ROOT) !== root ||
    env.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED !== '1' ||
    env.WORKTREE_PORT_OFFSET !== '0' ||
    dataDirectory !== join(root, '.cat-cafe/collective-service') ||
    cliPath !== join(root, 'packages/collective-service/dist/cli.js') ||
    isSymlinkOrUnreadable(join(root, '.cat-cafe')) ||
    isSymlinkOrUnreadable(dataDirectory)
  )
    return false;
  if (namedAlpha && (!namedAlpha.isCurrent() || namedAlpha.coordinates.alphaRoot !== root)) return false;
  if (!namedAlpha && env.CAT_CAFE_ALPHA_COORDINATES !== undefined) return false;
  const ports = namedAlpha?.coordinates.ports ?? { frontend: 3011, api: 3012, service: 5211 };
  return (
    env.FRONTEND_PORT === String(ports.frontend) &&
    env.API_SERVER_PORT === String(ports.api) &&
    [`http://localhost:${ports.frontend}`, `http://127.0.0.1:${ports.frontend}`].includes(frontendOrigin) &&
    serviceUrl === `http://127.0.0.1:${ports.service}`
  );
}

export function isNonRuntimeCollectiveEnvironment(env: NodeJS.ProcessEnv, root?: string): boolean {
  const offset = env.WORKTREE_PORT_OFFSET;
  return (
    (Boolean(offset) && offset !== '0') ||
    env.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED === '1' ||
    env.CAT_CAFE_DEPLOYMENT_ID === 'alpha' ||
    env.CAT_CAFE_ALPHA_COORDINATES !== undefined ||
    root !== undefined
  );
}

export function isAlphaCollectiveEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.CAT_CAFE_DEPLOYMENT_ID === 'alpha' || env.CAT_CAFE_ALPHA_COORDINATES !== undefined;
}

export function collectiveServiceEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly serviceUrl: string;
  readonly dataDirectory: string;
  readonly frontendOrigin: string;
  readonly isolatedAlpha: boolean;
  readonly namedAlpha?: NamedAlphaRuntimeBoundary;
}): Record<string, string> {
  const { env, serviceUrl, dataDirectory, frontendOrigin, isolatedAlpha, namedAlpha } = input;
  const environment: Record<string, string> = {};
  for (const key of [
    'HOME',
    'PATH',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'COLLECTIVE_GITHUB_CLIENT_ID',
    'COLLECTIVE_GITHUB_CLIENT_SECRET',
  ]) {
    if (isolatedAlpha && (key === 'COLLECTIVE_GITHUB_CLIENT_ID' || key === 'COLLECTIVE_GITHUB_CLIENT_SECRET')) continue;
    const value = env[key]?.trim();
    if (value) environment[key] = value;
  }
  const url = new URL(serviceUrl);
  const frontendPort = namedAlpha?.coordinates.ports.frontend ?? 3011;
  environment.COLLECTIVE_SERVICE_HOST = url.hostname;
  environment.COLLECTIVE_SERVICE_PORT = url.port;
  environment.COLLECTIVE_SERVICE_PUBLIC_URL = serviceUrl;
  environment.COLLECTIVE_SERVICE_DATA_DIR = dataDirectory;
  environment.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS = isolatedAlpha
    ? `http://localhost:${frontendPort},http://127.0.0.1:${frontendPort}`
    : frontendOrigin;
  return environment;
}
