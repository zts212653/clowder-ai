import { saveSpan } from '../utils/member-save-diagnostics.js';
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
import { z } from 'zod';
import { loadResolvedCatConfig, sessionStrategySchema, toAllCatConfigs } from '../config/cat-config-loader.js';
import { resolveProjectTemplatePath } from '../config/project-template-path.js';
import { withRuntimeCatMutationLock } from '../config/runtime-cat-catalog.js';
import { getSessionStrategyWithSource } from '../config/session-strategy.js';
import {
  deleteRuntimeOverride,
  getAllRuntimeOverrides,
  getRuntimeOverride,
  getRuntimeOverrideRevision,
  setRuntimeOverride,
} from '../config/session-strategy-overrides.js';
import { resolveSessionExecutionStatus } from '../domains/cats/services/agents/context-lifecycle-capability.js';
import type { AgentContextCapability } from '../domains/cats/services/types.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface SessionStrategyRouteOptions {
  resolveContextCapability?: (catId: string) => AgentContextCapability;
}

const strategyMutationSchema = sessionStrategySchema
  .unwrap()
  .partial()
  .extend({
    expectedRevision: z.string().min(1).optional(),
  });
const strategyDeleteSchema = z.object({ expectedRevision: z.string().min(1).optional() });

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

/** Share deletion's existing lock; check persisted membership after any wait, before writing S2. */
function withMemberStrategyMutation<T>(catId: string, write: () => Promise<T>) {
  const root = resolveActiveProjectRoot();
  return withRuntimeCatMutationLock(root, () => {
    const members = toAllCatConfigs(loadResolvedCatConfig(resolveProjectTemplatePath(root)));
    if (!members[catId]) throw Object.assign(new Error(`Unknown cat ID: "${catId}"`), { statusCode: 404 });
    return write();
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
        overrideRevision: getRuntimeOverrideRevision(catId),
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
    const parseResult = strategyMutationSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid strategy config', details: parseResult.error.issues };
    }

    const { expectedRevision, ...override } = parseResult.data;
    if (expectedRevision === undefined)
      return reply.code(428).send({ error: '请重新读取会话策略，携带 expectedRevision 后再保存。' });
    if (!override || Object.keys(override).length === 0) {
      reply.status(400);
      return { error: 'Empty override — use DELETE to remove an override' };
    }

    const capability = opts.resolveContextCapability?.(catId) ?? UNAVAILABLE_CONTEXT_CAPABILITY;

    // Zod .optional() produces `T | undefined` for nested props; our type uses optional-only.
    // Shapes are equivalent at runtime after validation.
    await withMemberStrategyMutation(catId, () =>
      saveSpan('strategy.persist', () =>
        setRuntimeOverride(
          catId,
          {
            ...getRuntimeOverride(catId),
            ...override,
          } as unknown as Partial<SessionStrategyConfig>,
          expectedRevision,
        ),
      ),
    );
    request.log.info({ operator, catId, override }, 'session strategy override set');

    // Return the new effective config after applying the override
    const { effective, source, revision, changedAt } = getSessionStrategyWithSource(catId);
    return {
      catId,
      effective,
      source,
      revision,
      overrideRevision: getRuntimeOverrideRevision(catId),
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

    const parsed = strategyDeleteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid strategy revision' });
    if (parsed.data.expectedRevision === undefined)
      return reply.code(428).send({ error: '请重新读取会话策略，携带 expectedRevision 后再删除覆盖。' });
    const existed = await withMemberStrategyMutation(catId, () =>
      deleteRuntimeOverride(catId, parsed.data.expectedRevision),
    );
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
      overrideRevision: getRuntimeOverrideRevision(catId),
      changedAt,
      executionStatus: executionStatusFor(capability, effective.strategy),
      deleted: true,
    };
  });
};
