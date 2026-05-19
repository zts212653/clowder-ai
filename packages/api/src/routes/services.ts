import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  type FetchServiceHealth,
  getServiceManifest,
  maskServiceEndpoint,
  resolveServiceEndpoint,
  resolveServiceEndpointMap,
  resolveServiceState,
  resolveServiceStates,
} from '../domains/services/service-manifest.js';
import { registerServiceLifecycleRoutes, type ServiceLifecycleRouteOptions } from './services-lifecycle-routes.js';

export interface ServicesRouteOptions {
  env?: NodeJS.ProcessEnv;
  fetchHealth?: FetchServiceHealth;
  lifecycle?: ServiceLifecycleRouteOptions;
}

function resolveSessionUserId(request: FastifyRequest): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireIdentity(request: FastifyRequest, reply: FastifyReply): boolean {
  if (resolveSessionUserId(request)) return true;
  reply.status(401);
  return false;
}

export const servicesRoutes: FastifyPluginAsync<ServicesRouteOptions> = async (app, options) => {
  app.get('/api/services', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const services = await resolveServiceStates({
      env: options.env,
      fetchHealth: options.fetchHealth,
    });
    return { services };
  });

  app.get('/api/services/endpoints', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    return {
      endpoints: resolveServiceEndpointMap(options.env),
    };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/health', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }

    const state = await resolveServiceState(service, {
      env: options.env,
      fetchHealth: options.fetchHealth,
    });
    return {
      id: state.id,
      endpoint: maskServiceEndpoint(resolveServiceEndpoint(service, options.env)),
      configured: state.configured,
      status: state.status,
      httpStatus: state.httpStatus,
      error: state.error,
    };
  });

  await registerServiceLifecycleRoutes(app, options);
};
