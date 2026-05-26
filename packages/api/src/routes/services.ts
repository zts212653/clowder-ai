import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getEnvironmentProfile } from '../domains/services/environment-detector.js';
import { buildRecommendation } from '../domains/services/recommendation-matrix.js';
import { getServiceConfig } from '../domains/services/service-config.js';
import { findPidsByPort } from '../domains/services/service-lifecycle.js';
import {
  type FetchServiceHealth,
  getServiceManifest,
  resolveEffectiveServiceConfig,
  resolveServiceEndpointMap,
  resolveServiceState,
  resolveServiceStates,
} from '../domains/services/service-manifest.js';
import { lifecycleOwnerError, requireLifecycleOwner } from './services-lifecycle-helpers.js';
import { createServiceLifecycleLock } from './services-lifecycle-lock.js';
import { resolveSuggestedServicePort } from './services-lifecycle-port.js';
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
  const getConfig = options.lifecycle?.serviceConfig?.get ?? getServiceConfig;
  const lookupPidsByPort = options.lifecycle?.findPidsByPort ?? findPidsByPort;
  const lifecycleLock = createServiceLifecycleLock();
  const getEffectiveConfig = (service: NonNullable<ReturnType<typeof getServiceManifest>>) => {
    return resolveEffectiveServiceConfig(service, getConfig(service.id), options.env ?? process.env);
  };

  app.get('/api/services', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const services = await resolveServiceStates({
      env: options.env,
      fetchHealth: options.fetchHealth,
      getConfig: (id) => {
        const service = getServiceManifest(id);
        return service ? getEffectiveConfig(service) : getConfig(id);
      },
      getLifecycleAction: lifecycleLock.getActiveAction,
    });
    return { services };
  });

  app.get('/api/services/endpoints', async (request, reply) => {
    // unmasked: this route is consumed by useVoiceInput / chat-voice to
    // actually issue STT/TTS/LLM-postprocess requests, so credential-in-URL
    // setups (e.g. WHISPER_URL=https://user:pass@host) must round-trip
    // intact. That makes the response a privilege-escalation surface --
    // any non-owner authenticated user otherwise reads upstream secrets.
    // Gate behind the same owner check used for lifecycle writes so the
    // unmasked URL never leaves the owner's session boundary
    // (codex P1 2026-05-26).
    if (!requireLifecycleOwner(request, reply)) return lifecycleOwnerError(reply);
    return {
      endpoints: resolveServiceEndpointMap(
        options.env,
        (id) => {
          const service = getServiceManifest(id);
          return service ? getEffectiveConfig(service) : getConfig(id);
        },
        { mask: false },
      ),
    };
  });

  // Env-aware install preview: detects the host environment (OS / arch /
  // GPU / Python) and returns the recommendation matrix entry for the
  // service — models that work on this machine, plus any unsupported
  // reason if the env is incompatible. Restored from F190 followup
  // pre-sync work after upstream sync #720 inadvertently removed the
  // env-detection + recommendation layer.
  // Serve the offline-install guide from the local repo so the help link
  // in InstallPreviewModal works in offline / air-gapped environments.
  // The HTML is pre-rendered and checked in at docs/services-offline-install.html
  // (regenerate from the .md source when it changes). Restored from
  // pre-sync F190 work — codex P2 3268952331.
  app.get('/api/services/docs/offline-install', async (_request, reply) => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const htmlPath = resolve(repoRoot, 'docs/services-offline-install.html');
    if (!existsSync(htmlPath)) {
      reply.status(404);
      return { error: 'docs/services-offline-install.html not found — regenerate from the .md source' };
    }
    reply.header('cache-control', 'no-cache');
    reply.type('text/html; charset=utf-8');
    return readFileSync(htmlPath, 'utf-8');
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/install-preview', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Authentication required' };
    const { id } = request.params;
    const service = getServiceManifest(id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const profile = getEnvironmentProfile(true);
    const recommendation = buildRecommendation(id, profile);

    // Suggest a concrete port for the modal to pre-fill. If neither
    // services.json nor *_PORT env pins one, scan from the manifest default
    // so the eventual install persists a findable port instead of leaving
    // "auto" as transient UI state.
    const suggestedPort = await resolveSuggestedServicePort({
      service,
      config: getEffectiveConfig(service),
      env: options.env ?? process.env,
      lookupPidsByPort,
    });

    return { profile, recommendation, suggestedPort };
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
      config: getEffectiveConfig(service),
      lifecycleAction: lifecycleLock.getActiveAction(request.params.id),
    });
    return {
      id: state.id,
      endpoint: state.endpoint,
      configured: state.configured,
      status: state.status,
      httpStatus: state.httpStatus,
      error: state.error,
    };
  });

  await registerServiceLifecycleRoutes(app, options, lifecycleLock);
};
