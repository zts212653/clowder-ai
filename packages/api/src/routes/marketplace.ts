import type { MarketplaceArtifactKind, MarketplaceEcosystem, TrustLevel } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { AdapterRegistry } from '../marketplace/adapter-registry.js';
import { validateInstallPlan } from '../marketplace/install-plan-bridge.js';

export interface MarketplaceRouteOptions {
  registry: AdapterRegistry;
}

export const marketplaceRoutes: FastifyPluginAsync<MarketplaceRouteOptions> = async (fastify, opts) => {
  const { registry } = opts;

  fastify.get('/api/marketplace/search', async (request, reply) => {
    const { q, ecosystems, trustLevels, artifactKinds, limit } = request.query as {
      q?: string;
      ecosystems?: string;
      trustLevels?: string;
      artifactKinds?: string;
      limit?: string;
    };

    if (!q) {
      return reply.status(400).send({ error: 'Missing required query parameter: q' });
    }

    const results = await registry.search({
      query: q,
      ecosystems: ecosystems?.split(',') as MarketplaceEcosystem[] | undefined,
      trustLevels: trustLevels?.split(',') as TrustLevel[] | undefined,
      artifactKinds: artifactKinds?.split(',') as MarketplaceArtifactKind[] | undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });

    return { results };
  });

  fastify.post('/api/marketplace/install/plan', async (request, reply) => {
    const { ecosystem, artifactId } = request.body as {
      ecosystem?: string;
      artifactId?: string;
    };

    if (!ecosystem || !artifactId) {
      return reply.status(400).send({ error: 'Missing required fields: ecosystem, artifactId' });
    }

    try {
      const plan = await registry.buildInstallPlan(ecosystem, artifactId);
      const errors = validateInstallPlan(plan);
      if (errors.length > 0) {
        return reply.status(500).send({ error: 'Invalid install plan', details: errors });
      }
      return { plan };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return reply.status(404).send({ error: message });
      }
      if (message.includes('No adapter')) {
        return reply.status(400).send({ error: message });
      }
      return reply.status(500).send({ error: message });
    }
  });
};
