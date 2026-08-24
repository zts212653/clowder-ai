import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { pluginAccessError, requirePluginOwnerLocalAccess, requirePluginWriteAccess } from './plugin-access-guards.js';

export type PersonalChromePlatformSupport = 'supported' | 'unsupported';
export type PersonalChromeHelperStatus = 'absent' | 'ready' | 'invalid' | 'unsupported';
export type PersonalChromeConfigStatus = 'absent' | 'ready' | 'invalid' | 'unsupported';
export type PersonalChromeAuthorizationStatus = 'empty' | 'authorized' | 'invalid' | 'unsupported';
export type PersonalChromeLiveStatus = 'dormant' | 'connected' | 'degraded' | 'unsupported';

export interface PersonalChromeAuthorizedConversation {
  readonly conversationId: string;
  readonly authorizedAt: string;
  readonly updatedAt: string;
}

export interface PersonalChromePluginState {
  readonly pluginId: 'personal-chrome-host';
  readonly channel: 'developer_preview';
  readonly platform: string;
  readonly platformSupport: PersonalChromePlatformSupport;
  readonly artifact: {
    readonly helper: PersonalChromeHelperStatus;
    readonly extension: 'chrome_web_store';
  };
  readonly distribution: {
    readonly channel: 'chrome_web_store';
    readonly integration: 'ready';
    readonly publication: 'unavailable' | 'published' | 'invalid';
    readonly listingUrl?: string;
    readonly blockerCode?: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED' | 'CHROME_WEB_STORE_LISTING_INVALID';
  };
  readonly config: {
    readonly status: PersonalChromeConfigStatus;
  };
  readonly authorization: {
    readonly status: PersonalChromeAuthorizationStatus;
    readonly count: number;
    readonly limit: number;
    readonly conversations: readonly PersonalChromeAuthorizedConversation[];
  };
  readonly intent: {
    readonly status: 'developer_preview';
  };
  readonly live: {
    readonly status: PersonalChromeLiveStatus;
  };
}

export interface PersonalChromePluginPort {
  inspect(): Promise<PersonalChromePluginState>;
  install(): Promise<PersonalChromePluginState>;
  repair(): Promise<PersonalChromePluginState>;
  revoke(conversationId: string): Promise<PersonalChromePluginState>;
  uninstall(): Promise<PersonalChromePluginState>;
}

interface PersonalChromePluginRouteOptions {
  readonly port: PersonalChromePluginPort;
}

type MutationAction = 'install' | 'repair' | 'uninstall';

function operationErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function operationError(reply: FastifyReply, error: unknown): { error: string; code: string } {
  const code = operationErrorCode(error);
  if (code === 'HELPER_ACTIVE') {
    reply.status(409);
    return { error: 'Close Chrome before uninstalling Personal ChatGPT Pro', code };
  }
  if (code === 'UNSUPPORTED_PLATFORM') {
    reply.status(409);
    return { error: 'Personal ChatGPT Pro is not supported on this platform yet', code };
  }
  if (code === 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED') {
    reply.status(409);
    return { error: 'Chrome Web Store listing is not configured or published', code };
  }
  if (code === 'CHROME_WEB_STORE_LISTING_INVALID') {
    reply.status(409);
    return { error: 'Chrome Web Store listing configuration is invalid', code };
  }
  if (code === 'AUTHORIZATION_NOT_FOUND') {
    reply.status(404);
    return { error: 'ChatGPT conversation authorization was not found', code };
  }
  if (code === 'AUTHORIZATION_BUSY') {
    reply.status(409);
    return { error: 'ChatGPT conversation authorizations are busy; retry', code };
  }
  reply.status(500);
  return { error: 'Personal ChatGPT Pro operation failed', code: code ?? 'OPERATION_FAILED' };
}

export function registerPersonalChromePluginRoutes(
  app: FastifyInstance,
  options: PersonalChromePluginRouteOptions,
): void {
  app.get('/api/plugins/personal-chrome', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return options.port.inspect();
  });

  const mutate = (action: MutationAction) => async (request: FastifyRequest, reply: FastifyReply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    try {
      return await options.port[action]();
    } catch (error) {
      return operationError(reply, error);
    }
  };

  app.post('/api/plugins/personal-chrome/install', mutate('install'));
  app.post('/api/plugins/personal-chrome/repair', mutate('repair'));
  app.post('/api/plugins/personal-chrome/uninstall', mutate('uninstall'));

  app.delete<{ Params: { conversationId: string } }>(
    '/api/plugins/personal-chrome/authorizations/:conversationId',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request);
      if ('error' in access) return pluginAccessError(reply, access);
      const { conversationId } = request.params;
      if (!/^[A-Za-z0-9-]{1,200}$/.test(conversationId)) {
        reply.status(400);
        return { error: 'ChatGPT conversation ID is invalid', code: 'INVALID_CONVERSATION_ID' };
      }
      try {
        return await options.port.revoke(conversationId);
      } catch (error) {
        return operationError(reply, error);
      }
    },
  );
}
