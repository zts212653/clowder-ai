/**
 * Provider (agent CLI) availability routes.
 *
 * Read-only status plus an owner-gated manual re-check. Nothing here mutates member config:
 * the report is advisory, and adopting a detected CLI still goes through `POST /api/cats` so
 * the existing alias / account-binding / serviceTier validation stays the single write path.
 *
 * Identity is required for the same reason the first-run detection endpoint requires it: the
 * report lists absolute install paths, which is machine detail not meant for anonymous callers.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PROVIDER_DISCOVERY_INTERVAL_ENV,
  type ProviderAvailabilityRegistry,
  resolveDiscoveryIntervalMs,
} from '../domains/cats/services/agents/providers/ProviderAvailabilityRegistry.js';
import { detectProviderAvailability } from '../domains/cats/services/agents/providers/provider-detection.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface ClientsRouteOptions {
  /**
   * The shared registry. Optional so a route-only test can mount this plugin without wiring
   * the background loop; the routes then detect on demand.
   */
  registry?: ProviderAvailabilityRegistry;
}

function missingIdentity(reply: { status: (code: number) => void }): { error: string } {
  reply.status(401);
  return { error: 'Identity required' };
}

export const clientsRoutes: FastifyPluginAsync<ClientsRouteOptions> = async (app, options) => {
  const { registry } = options;

  /** Current availability for every client in the descriptor registry. */
  app.get('/api/clients', async (request: FastifyRequest, reply) => {
    if (!resolveUserId(request)) return missingIdentity(reply);

    // Prefer the cached report. A live round is the fallback for a registry that has nothing yet
    // (its first round is still in flight, or it failed) and for a mount without a registry at
    // all; in both of those cases the report we return was just produced, so its age is 0.
    const cached = registry?.getReport() ?? null;
    const report = cached ?? (await detectProviderAvailability());
    return {
      detectedAt: report.detectedAt,
      // Derived from `detectedAt`, so the two can never disagree. `null` means the age is unknown
      // and must NOT be read as fresh.
      ageMs: cached ? (registry?.getAgeMs() ?? null) : 0,
      discoveryIntervalMs: resolveDiscoveryIntervalMs(),
      discoveryIntervalEnv: PROVIDER_DISCOVERY_INTERVAL_ENV,
      providers: report.providers,
    };
  });

  /**
   * Re-run detection now. Owner-gated: an unauthenticated refresh would let any local caller
   * drive repeated filesystem sweeps.
   */
  app.post('/api/clients/refresh', async (request: FastifyRequest, reply) => {
    const userId = resolveUserId(request);
    if (!userId) return missingIdentity(reply);

    const gate = resolveOwnerGate(userId, { errorMessage: 'Provider re-detection requires owner authorization' });
    if (gate) {
      reply.status(gate.status);
      return { error: gate.error };
    }

    // A registry-less mount still answers honestly rather than returning a stale 200.
    if (!registry) {
      const report = await detectProviderAvailability();
      return { detectedAt: report.detectedAt, ageMs: 0, providers: report.providers };
    }

    const report = await registry.refresh();
    return { detectedAt: report.detectedAt, ageMs: registry.getAgeMs(), providers: report.providers };
  });
};
