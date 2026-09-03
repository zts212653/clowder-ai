import { readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  COLLECTIVE_CLIENT_BUILD_ID,
  collectiveClientHtml,
  resolveCollectiveClientAsset,
} from '@cat-cafe/collective-client';
import { CollectiveServiceError } from './errors.js';
import {
  applySecurityHeaders,
  clearHumanAuthCompletionCookie,
  forbiddenOrigin,
  normalizedOrigin,
  numberQuery,
  optionalBearer,
  parseHumanAuthIntent,
  readJsonBody,
  requireAllowedOrigin,
  requireBearer,
  requiredQuery,
  requiredString,
  requireFields,
  requireHumanAuthCompletionCookie,
  setHumanAuthCompletionCookie,
  writeError,
  writeJson,
} from './http-transport.js';
import type { CollectiveServiceStore } from './store.js';

interface CollectiveHttpHandlerOptions {
  readonly store: CollectiveServiceStore;
  readonly allowedHostOrigins: readonly string[];
  readonly bootstrapLinkPath?: string;
}

export function createCollectiveHttpHandler(options: CollectiveHttpHandlerOptions) {
  const allowedOrigins = new Set(options.allowedHostOrigins.map((origin) => new URL(origin).origin));
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      applySecurityHeaders(response, allowedOrigins);
      const origin = normalizedOrigin(request.headers.origin);
      if (origin && allowedOrigins.has(origin)) response.setHeader('access-control-allow-origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        response.setHeader('access-control-allow-headers', 'authorization,content-type');
        response.writeHead(origin && allowedOrigins.has(origin) ? 204 : 403).end();
        return;
      }
      await routeRequest(options.store, allowedOrigins, options.bootstrapLinkPath, request, response);
    } catch (error) {
      writeError(response, error);
    }
  };
}

async function routeRequest(
  store: CollectiveServiceStore,
  allowedOrigins: ReadonlySet<string>,
  bootstrapLinkPath: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://collective.local');
  const method = request.method ?? 'GET';
  const clientAsset = method === 'GET' ? resolveCollectiveClientAsset(url.pathname) : undefined;
  if (clientAsset) {
    response.setHeader('content-type', clientAsset.contentType);
    response.setHeader('cache-control', 'no-cache');
    response.writeHead(200).end(await readFile(clientAsset.path));
    return;
  }
  if (method === 'GET') {
    await routeGet(store, url, request, response);
    return;
  }
  if (method !== 'POST') {
    routeClientFallback(url, response);
    return;
  }
  await routePost(store, allowedOrigins, bootstrapLinkPath, url, request, response);
}

async function routeGet(
  store: CollectiveServiceStore,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (url.pathname === '/api/health') {
    writeJson(response, 200, { ok: true, ...store.getMetadata() });
    return;
  }
  if (url.pathname === '/api/meta') {
    writeJson(response, 200, store.getMetadata());
    return;
  }
  if (url.pathname === '/api/auth/providers') {
    writeJson(response, 200, { providers: store.getHumanAuthProviders() });
    return;
  }
  if (url.pathname === '/api/auth/github/callback') {
    if (url.searchParams.has('error')) {
      redirectHumanAuthError(response, 'authorization_denied', humanAuthCookieIsSecure(store));
      return;
    }
    try {
      const completion = await store.completeHumanAuth({
        provider: 'github',
        state: requiredQuery(url, 'state'),
        code: requiredQuery(url, 'code'),
      });
      setHumanAuthCompletionCookie(response, completion.completionToken, humanAuthCookieIsSecure(store));
      response.setHeader('location', '/?authCompleted=1');
      response.writeHead(303).end();
    } catch (error) {
      redirectHumanAuthError(response, humanAuthErrorCode(error), humanAuthCookieIsSecure(store));
    }
    return;
  }
  if (url.pathname === '/api/me') {
    writeJson(response, 200, await store.getHumanProjection(requireBearer(request)));
    return;
  }
  if (url.pathname === '/api/events/human') {
    const collectiveId = requiredQuery(url, 'collectiveId');
    writeJson(response, 200, {
      serviceInstanceId: store.serviceInstanceId,
      collectiveId,
      events: await store.listEventsForHuman(requireBearer(request), collectiveId),
    });
    return;
  }
  if (url.pathname === '/api/events/endpoint') {
    writeJson(
      response,
      200,
      await store.pollEvents(requireBearer(request), {
        serviceInstanceId: requiredQuery(url, 'serviceInstanceId'),
        collectiveId: requiredQuery(url, 'collectiveId'),
        connectionId: requiredQuery(url, 'connectionId'),
        afterSequence: numberQuery(url, 'afterSequence', 0),
        limit: numberQuery(url, 'limit', 100),
      }),
    );
    return;
  }
  routeClientFallback(url, response);
}

type HumanAuthRedirectError =
  | 'authorization_denied'
  | 'authorization_expired'
  | 'identity_conflict'
  | 'provider_unavailable'
  | 'authorization_failed';

function humanAuthErrorCode(error: unknown): HumanAuthRedirectError {
  if (!(error instanceof CollectiveServiceError)) return 'provider_unavailable';
  if (
    error.code === 'AUTH_ATTEMPT_CONSUMED' ||
    error.code === 'AUTH_ATTEMPT_EXPIRED' ||
    error.code === 'INVITE_EXPIRED'
  ) {
    return 'authorization_expired';
  }
  if (error.code === 'AUTH_IDENTITY_CONFLICT') return 'identity_conflict';
  if (error.code === 'AUTH_PROVIDER_NOT_READY' || error.code === 'AUTH_IDENTITY_INVALID') {
    return 'provider_unavailable';
  }
  return 'authorization_failed';
}

function redirectHumanAuthError(response: ServerResponse, code: HumanAuthRedirectError, secure: boolean): void {
  clearHumanAuthCompletionCookie(response, secure);
  response.setHeader('location', `/?authError=${code}`);
  response.writeHead(303).end();
}

async function routePost(
  store: CollectiveServiceStore,
  allowedOrigins: ReadonlySet<string>,
  bootstrapLinkPath: string | undefined,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  if (await routeIdentityPost(store, bootstrapLinkPath, url.pathname, request, response, body)) return;
  if (await routeConnectionPost(store, allowedOrigins, url.pathname, request, response, body)) return;
  if (await routeEventPost(store, url.pathname, request, response, body)) return;
  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

async function routeIdentityPost(
  store: CollectiveServiceStore,
  bootstrapLinkPath: string | undefined,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname === '/api/bootstrap') {
    const result = await store.consumeBootstrap(requireFields(body, ['secret', 'displayName']));
    if (bootstrapLinkPath) await rm(bootstrapLinkPath, { force: true }).catch(() => undefined);
    writeJson(response, 201, result);
  } else if (pathname === '/api/collectives') {
    writeJson(
      response,
      201,
      await store.createCollective({
        sessionToken: requireBearer(request),
        name: requiredString(body, 'name'),
      }),
    );
  } else if (pathname === '/api/invites') {
    writeJson(
      response,
      201,
      await store.createInvite({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
      }),
    );
  } else if (pathname === '/api/join') {
    writeJson(response, 201, await store.joinInvite(requireFields(body, ['inviteToken', 'displayName'])));
  } else if (pathname === '/api/auth/github/begin') {
    const result = await store.beginHumanAuth({
      provider: 'github',
      intent: parseHumanAuthIntent(body),
      ...(optionalBearer(request) ? { sessionToken: optionalBearer(request) } : {}),
    });
    clearHumanAuthCompletionCookie(response, humanAuthCookieIsSecure(store));
    writeJson(response, 201, result);
  } else if (pathname === '/api/auth/completions/exchange') {
    const secure = humanAuthCookieIsSecure(store);
    try {
      const completionToken = requireHumanAuthCompletionCookie(request);
      const result = await store.exchangeHumanAuthCompletion(completionToken);
      clearHumanAuthCompletionCookie(response, secure);
      writeJson(response, 200, result);
    } catch (error) {
      clearHumanAuthCompletionCookie(response, secure);
      throw error;
    }
  } else {
    return false;
  }
  return true;
}

function humanAuthCookieIsSecure(store: CollectiveServiceStore): boolean {
  return new URL(store.getHumanAuthRedirectUri()).protocol === 'https:';
}

async function routeConnectionPost(
  store: CollectiveServiceStore,
  allowedOrigins: ReadonlySet<string>,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname === '/api/pairing-intents') {
    const hostOrigin = normalizedOrigin(requiredString(body, 'hostOrigin'));
    requireAllowedOrigin(hostOrigin, allowedOrigins);
    writeJson(
      response,
      201,
      await store.createPairingIntent({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
        hostOrigin,
        nonce: requiredString(body, 'nonce'),
      }),
    );
  } else if (pathname === '/api/connections/exchange') {
    await exchangeConnection(store, allowedOrigins, request, response, body);
  } else if (pathname === '/api/connections/revoke') {
    writeJson(
      response,
      200,
      await store.revokeConnection({
        sessionToken: requireBearer(request),
        collectiveId: requiredString(body, 'collectiveId'),
        connectionId: requiredString(body, 'connectionId'),
      }),
    );
  } else if (pathname === '/api/connections/self-revoke') {
    writeJson(response, 200, await store.revokeOwnConnection(requireBearer(request), body));
  } else {
    return false;
  }
  return true;
}

async function routeEventPost(
  store: CollectiveServiceStore,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (pathname === '/api/events/human') {
    writeJson(response, 201, await store.postHumanMessage(requireBearer(request), body));
  } else if (pathname === '/api/events/agent') {
    writeJson(response, 201, await store.postAgentMessage(requireBearer(request), body));
  } else if (pathname === '/api/acks') {
    writeJson(response, 200, await store.acknowledge(requireBearer(request), body));
  } else {
    return false;
  }
  return true;
}

async function exchangeConnection(
  store: CollectiveServiceStore,
  allowedOrigins: ReadonlySet<string>,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const origin = normalizedOrigin(request.headers.origin);
  requireAllowedOrigin(origin, allowedOrigins);
  const exchange = requireFields(body, [
    'serviceInstanceId',
    'collectiveId',
    'pairingIntentId',
    'hostOrigin',
    'nonce',
    'endpointLabel',
  ]);
  if (normalizedOrigin(exchange.hostOrigin) !== origin) forbiddenOrigin();
  writeJson(response, 201, await store.exchangePairingIntent(exchange));
}

function routeClientFallback(url: URL, response: ServerResponse): void {
  if (url.pathname.startsWith('/api/')) {
    writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('x-collective-client-build', COLLECTIVE_CLIENT_BUILD_ID);
  response.writeHead(200).end(collectiveClientHtml());
}
