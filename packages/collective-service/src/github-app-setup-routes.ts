import type { IncomingMessage, ServerResponse } from 'node:http';

import { CollectiveServiceError } from './errors.js';
import type { GitHubAppManifestSetup } from './github-app-manifest-setup.js';
import { optionalBearer, requiredQuery, writeJson } from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

export async function routeGitHubAppSetupGet(
  store: CollectiveServiceStore,
  setup: GitHubAppManifestSetup | undefined,
  url: URL,
  response: ServerResponse,
): Promise<boolean> {
  if (url.pathname === '/api/auth/providers') {
    writeJson(response, 200, {
      providers: store
        .getHumanAuthProviders()
        .map((provider) => ({ ...provider, ...(setup ? { setupSupported: true } : {}) })),
    });
    return true;
  }
  if (url.pathname !== '/api/setup/github-app/callback') return false;
  if (!setup || url.searchParams.has('error')) {
    redirectGitHubAppSetup(response, 'authorization_denied');
    return true;
  }
  try {
    await setup.complete({ state: requiredQuery(url, 'state'), code: requiredQuery(url, 'code') });
    response.setHeader('location', '/?providerConfigured=1');
    response.writeHead(303).end();
  } catch {
    redirectGitHubAppSetup(response, 'provider_unavailable');
  }
  return true;
}

export async function routeGitHubAppSetupPost(
  store: CollectiveServiceStore,
  setup: GitHubAppManifestSetup | undefined,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname !== '/api/setup/github-app/begin') return false;
  if (!setup) {
    throw new CollectiveServiceError('AUTH_PROVIDER_NOT_READY', 'GitHub App setup is unavailable', 503);
  }
  const sessionToken = optionalBearer(request);
  store.authorizeProviderSetup({
    ...(typeof body.bootstrapSecret === 'string' ? { bootstrapSecret: body.bootstrapSecret } : {}),
    ...(sessionToken ? { sessionToken } : {}),
  });
  const serviceUrl = new URL(store.getHumanAuthRedirectUri()).origin;
  writeJson(
    response,
    201,
    await setup.begin({
      serviceInstanceId: store.serviceInstanceId,
      serviceUrl,
      humanAuthCallbackUrl: store.getHumanAuthRedirectUri(),
      setupCallbackUrl: new URL('/api/setup/github-app/callback', serviceUrl).toString(),
    }),
  );
  return true;
}

function redirectGitHubAppSetup(response: ServerResponse, code: 'authorization_denied' | 'provider_unavailable'): void {
  response.setHeader('location', `/?providerSetupError=${code}`);
  response.writeHead(303).end();
}
