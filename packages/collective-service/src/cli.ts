import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensurePrivateDirectory, writeAtomicPrivate } from '@cat-cafe/shared/node-private-fs';

import { resolveCollectivePublicUrl } from './cli-config.js';
import { CollectiveServiceError } from './errors.js';
import { GitHubAppManifestSetup } from './github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from './github-human-auth-provider.js';
import { startCollectiveServer } from './http-server.js';
import { CollectiveServiceStore } from './store.js';

async function main(): Promise<void> {
  const host = process.env.COLLECTIVE_SERVICE_HOST?.trim() || '127.0.0.1';
  const port = parsePort(process.env.COLLECTIVE_SERVICE_PORT, 5201);
  const dataDirectory = resolveDataDirectory(process.env.COLLECTIVE_SERVICE_DATA_DIR);
  const allowedHostOrigins = parseOrigins(process.env.COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS);
  const publicUrl = resolveCollectivePublicUrl(process.env.COLLECTIVE_SERVICE_PUBLIC_URL, host, port);
  const humanAuthProvider = new ConfigurableGitHubHumanAuthProvider({
    clientId: process.env.COLLECTIVE_GITHUB_CLIENT_ID,
    clientSecret: process.env.COLLECTIVE_GITHUB_CLIENT_SECRET,
  });
  if (port === 0) throw new Error('COLLECTIVE_SERVICE_PORT must be nonzero for a durable initialization URL');
  await ensurePrivateDirectory(dataDirectory);
  const githubAppSetup = await GitHubAppManifestSetup.open({ dataDirectory, provider: humanAuthProvider });
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider,
    humanAuthRedirectUri: new URL('/api/auth/github/callback', publicUrl).toString(),
    bootstrapUrl: publicUrl,
  });
  const bootstrapLinkPath = opened.store.getMetadata().bootstrapNeeded
    ? resolve(dataDirectory, 'owner-bootstrap.url')
    : undefined;
  const running = await startCollectiveServer({
    store: opened.store,
    host,
    port,
    allowedHostOrigins,
    bootstrapLinkPath,
    githubAppSetup,
  });
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

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'collective-service-failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  // Secret-free, PID-fenced diagnostic for the Host that spawned this process.
  // An ACL failure cannot write this file; Host checks that boundary before spawn.
  const path = resolve(
    resolveDataDirectory(process.env.COLLECTIVE_SERVICE_DATA_DIR),
    'collective-service-startup.json',
  );
  try {
    await writeAtomicPrivate(
      path,
      `${JSON.stringify({
        pid: process.pid,
        launchId: process.env.COLLECTIVE_SERVICE_LAUNCH_ID,
        status: 'failed',
        code:
          error instanceof CollectiveServiceError && error.code === 'BOOTSTRAP_UNRECOVERABLE'
            ? error.code
            : 'STARTUP_FAILED',
      })}\n`,
    );
  } catch {
    // stderr remains the primary diagnostic when private storage is unavailable.
  }
  process.exitCode = 1;
});
