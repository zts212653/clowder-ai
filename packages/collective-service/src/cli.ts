import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { resolveCollectivePublicUrl } from './cli-config.js';
import { createGitHubHumanAuthProvider } from './github-human-auth-provider.js';
import { startCollectiveServer } from './http-server.js';
import { CollectiveServiceStore } from './store.js';

async function main(): Promise<void> {
  const host = process.env.COLLECTIVE_SERVICE_HOST?.trim() || '127.0.0.1';
  const port = parsePort(process.env.COLLECTIVE_SERVICE_PORT, 5201);
  const dataDirectory = resolveDataDirectory(process.env.COLLECTIVE_SERVICE_DATA_DIR);
  const allowedHostOrigins = parseOrigins(process.env.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS);
  const publicUrl = resolveCollectivePublicUrl(process.env.COLLECTIVE_SERVICE_PUBLIC_URL, host, port);
  const humanAuthProvider = createGitHubHumanAuthProvider({
    clientId: process.env.COLLECTIVE_GITHUB_CLIENT_ID,
    clientSecret: process.env.COLLECTIVE_GITHUB_CLIENT_SECRET,
  });
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider,
    humanAuthRedirectUri: new URL('/api/auth/github/callback', publicUrl).toString(),
  });
  const bootstrapLinkPath = opened.bootstrapSecret ? resolve(dataDirectory, 'owner-bootstrap.url') : undefined;
  const running = await startCollectiveServer({
    store: opened.store,
    host,
    port,
    allowedHostOrigins,
    bootstrapLinkPath,
  });
  if (bootstrapLinkPath && opened.bootstrapSecret) {
    await writeFile(bootstrapLinkPath, `${running.url}/#bootstrap=${encodeURIComponent(opened.bootstrapSecret)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(bootstrapLinkPath, 0o600);
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'collective-service-ready',
      pid: process.pid,
      url: running.url,
      dataDirectory,
      serviceInstanceId: opened.store.serviceInstanceId,
      clientBuildId: opened.store.getMetadata().clientBuildId,
      bootstrapLinkPath,
    })}\n`,
  );
  const stop = async () => {
    await running.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function resolveDataDirectory(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return resolve(homedir(), '.cat-cafe', 'collective-service');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error('COLLECTIVE_SERVICE_PORT must be an integer between 0 and 65535');
  }
  return parsed;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((origin) => new URL(origin.trim()).origin)
    .filter((origin, index, all) => all.indexOf(origin) === index);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'collective-service-failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
