/**
 * F33 Phase 3: Session Strategy Configuration Routes
 *
 * GET    /api/config/session-strategy           — all variant cats' effective strategy + source
 * PATCH  /api/config/session-strategy/:catId    — set runtime override (Redis-backed)
 * DELETE /api/config/session-strategy/:catId    — remove runtime override (fall back to lower sources)
 */

import type { SessionStrategyConfig } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { sessionStrategySchema } from '../config/cat-config-loader.js';
import { getSessionStrategyWithSource } from '../config/session-strategy.js';
import {
  deleteRuntimeOverride,
  getAllRuntimeOverrides,
  setRuntimeOverride,
} from '../config/session-strategy-overrides.js';
import { resolveSessionExecutionStatus } from '../domains/cats/services/agents/context-lifecycle-capability.js';
import type { AgentContextCapability } from '../domains/cats/services/types.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface SessionStrategyRouteOptions {
  resolveContextCapability?: (catId: string) => AgentContextCapability;
}

const UNAVAILABLE_CONTEXT_CAPABILITY: AgentContextCapability = {
  provider: 'unknown',
  carrier: 'unknown',
  reportsRuntimeWindow: false,
  authoritativeUsage: false,
  usageTelemetry: 'unavailable',
  nativeWindowControl: false,
  nativeCompressionControl: false,
  observesCompression: false,
  reason: 'No concrete context capability is registered for this member',
};

function executionStatusFor(capability: AgentContextCapability, strategy: SessionStrategyConfig['strategy']) {
  const hasWindowBinding = capability.reportsRuntimeWindow || capability.nativeWindowControl;
  return resolveSessionExecutionStatus(strategy, {
    managedInvocationBoundary: true,
    effectiveInputCeiling: hasWindowBinding,
    carrierBinding: hasWindowBinding,
    authoritativeUsage: capability.authoritativeUsage && capability.usageTelemetry === 'available',
    sessionRotation: true,
    continuityBootstrap: true,
    observesCompression: capability.observesCompression,
  });
}

export const sessionStrategyConfigRoutes: FastifyPluginAsync<SessionStrategyRouteOptions> = async (app, opts) => {
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

      const { effective, source, revision, changedAt } = getSessionStrategyWithSource(catId);
      const override = allOverrides.get(catId);
      const capability = opts.resolveContextCapability?.(catId) ?? UNAVAILABLE_CONTEXT_CAPABILITY;

      cats.push({
        catId,
        displayName: entry.config.displayName,
        clientId: entry.config.clientId,
        breedId: entry.config.breedId,
        effective,
        source,
        revision,
        changedAt,
        executionStatus: executionStatusFor(capability, effective.strategy),
        hasOverride: override != null,
        override: override ?? null,
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
    const operator = resolveHeaderUserId(request);
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

    if (request.body != null && typeof request.body === 'object' && Object.hasOwn(request.body, 'sessionChain')) {
      reply.status(400);
      return { error: 'Legacy sessionChain writes are not accepted; save session strategy intent only' };
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

    const capability = opts.resolveContextCapability?.(catId) ?? UNAVAILABLE_CONTEXT_CAPABILITY;

    // Zod .optional() produces `T | undefined` for nested props; our type uses optional-only.
    // Shapes are equivalent at runtime after validation.
    await setRuntimeOverride(catId, override as unknown as Partial<SessionStrategyConfig>);
    request.log.info({ operator, catId, override }, 'session strategy override set');

    // Return the new effective config after applying the override
    const { effective, source, revision, changedAt } = getSessionStrategyWithSource(catId);
    return {
      catId,
      effective,
      source,
      revision,
      changedAt,
      executionStatus: executionStatusFor(capability, effective.strategy),
      override,
    };
  });

  /**
   * DELETE /api/config/session-strategy/:catId
   * Remove a runtime override for a variant cat — it falls back to lower-priority sources.
   */
  app.delete<{ Params: { catId: string } }>('/api/config/session-strategy/:catId', async (request, reply) => {
    const operator = resolveHeaderUserId(request);
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
    const { effective, source, revision, changedAt } = getSessionStrategyWithSource(catId);
    const capability = opts.resolveContextCapability?.(catId) ?? UNAVAILABLE_CONTEXT_CAPABILITY;
    return {
      catId,
      effective,
      source,
      revision,
      changedAt,
      executionStatus: executionStatusFor(capability, effective.strategy),
      deleted: true,
    };
  });
};
