/**
 * F33 Phase 3: Session Strategy Configuration Routes
 *
 * GET    /api/config/session-strategy           — all variant cats' effective strategy + source
 * PATCH  /api/config/session-strategy/:catId    — set runtime override (Redis-backed)
 * DELETE /api/config/session-strategy/:catId    — remove runtime override (fall back to lower sources)
 */

import type { SessionStrategyConfig } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { isSessionChainEnabled, sessionStrategySchema } from '../config/cat-config-loader.js';
import { getSessionStrategyWithSource } from '../config/session-strategy.js';
import {
  deleteRuntimeOverride,
  getAllRuntimeOverrides,
  setRuntimeOverride,
} from '../config/session-strategy-overrides.js';

/** Providers that support compression event signaling (PreCompact hook) */
const HOOK_CAPABLE_PROVIDERS = new Set(['anthropic']);

function resolveOperator(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof first === 'string') return first.trim();
  }
  return null;
}

export async function sessionStrategyConfigRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  /**
   * GET /api/config/session-strategy
   * Returns every registered variant cat's effective strategy, source, and override status.
   */
  app.get('/api/config/session-strategy', async () => {
    const allOverrides = getAllRuntimeOverrides();
    const cats = [];

    for (const id of catRegistry.getAllIds()) {
      const catId = id as string;
      const entry = catRegistry.tryGet(catId);
      if (!entry) continue;

      const { effective, source } = getSessionStrategyWithSource(catId);
      const override = allOverrides.get(catId);

      cats.push({
        catId,
        displayName: entry.config.displayName,
        clientId: entry.config.clientId,
        breedId: entry.config.breedId,
        effective,
        source,
        hasOverride: override != null,
        override: override ?? null,
        hybridCapable: HOOK_CAPABLE_PROVIDERS.has(entry.config.clientId),
        sessionChainEnabled: isSessionChainEnabled(catId),
      });
    }

    return { cats };
  });

  /**
   * PATCH /api/config/session-strategy/:catId
   * Set or update a runtime strategy override for a specific variant cat.
   * The override is deep-merged with the base strategy at read time.
   */
  app.patch<{ Params: { catId: string } }>('/api/config/session-strategy/:catId', async (request, reply) => {
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { catId } = request.params;

    // Verify cat exists in registry
    const entry = catRegistry.tryGet(catId);
    if (!entry) {
      reply.status(404);
      return { error: `Unknown cat ID: "${catId}"` };
    }

    // Validate the override payload with the shared Zod schema
    const parseResult = sessionStrategySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid strategy config', details: parseResult.error.issues };
    }

    const override = parseResult.data;
    if (!override || Object.keys(override).length === 0) {
      reply.status(400);
      return { error: 'Empty override — use DELETE to remove an override' };
    }

    // Guard: hybrid requires hook-capable provider
    if (override.strategy === 'hybrid' && !HOOK_CAPABLE_PROVIDERS.has(entry.config.clientId)) {
      reply.status(422);
      return {
        error:
          `hybrid strategy requires a hook-capable provider (${[...HOOK_CAPABLE_PROVIDERS].join(', ')}), ` +
          `but "${catId}" uses provider "${entry.config.clientId}"`,
      };
    }

    // Zod .optional() produces `T | undefined` for nested props; our type uses optional-only.
    // Shapes are equivalent at runtime after validation.
    await setRuntimeOverride(catId, override as unknown as Partial<SessionStrategyConfig>);
    request.log.info({ operator, catId, override }, 'session strategy override set');

    // Return the new effective config after applying the override
    const { effective, source } = getSessionStrategyWithSource(catId);
    return {
      catId,
      effective,
      source,
      override,
    };
  });

  /**
   * DELETE /api/config/session-strategy/:catId
   * Remove a runtime override for a variant cat — it falls back to lower-priority sources.
   */
  app.delete<{ Params: { catId: string } }>('/api/config/session-strategy/:catId', async (request, reply) => {
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { catId } = request.params;

    // Verify cat exists in registry
    if (!catRegistry.tryGet(catId)) {
      reply.status(404);
      return { error: `Unknown cat ID: "${catId}"` };
    }

    const existed = await deleteRuntimeOverride(catId);
    request.log.info({ operator, catId, deleted: existed }, 'session strategy override delete');
    if (!existed) {
      reply.status(404);
      return { error: `No runtime override exists for "${catId}"` };
    }

    // Return the new effective config after removing the override
    const { effective, source } = getSessionStrategyWithSource(catId);
    return { catId, effective, source, deleted: true };
  });
}
