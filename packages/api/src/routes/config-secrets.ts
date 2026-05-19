/**
 * Config Secrets Route — F136 Phase 2
 *
 * POST /api/config/secrets — write connector tokens via Hub config wizard.
 * Allowlist-gated, loopback-guarded, audit-logged (keys only, never values).
 */

import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyConnectorSecretUpdates } from '../config/connector-secret-updater.js';
import {
  requireConnectorWriteOwner,
  resolveConnectorSessionUserId,
  validateConnectorSecretUpdate,
} from '../config/connector-secret-write-guards.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { isLoopbackAddress } from '../utils/loopback-request.js';

const secretsPatchSchema = z.object({
  updates: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.string().nullable(),
      }),
    )
    .min(1),
});

interface ConfigSecretsRoutesOptions {
  auditLog?: {
    append(input: { type: string; data: Record<string, unknown> }): Promise<unknown>;
  };
  envFilePath?: string;
  skipLoopbackCheck?: boolean;
}

function validateSecretUpdate(update: { name: string; value: string | null }): string | null {
  return validateConnectorSecretUpdate(update);
}

export async function configSecretsRoutes(app: FastifyInstance, opts: ConfigSecretsRoutesOptions = {}): Promise<void> {
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const projectRoot = resolveActiveProjectRoot();
  const envFilePath = opts.envFilePath ?? resolve(projectRoot, '.env');

  app.post('/api/config/secrets', async (request, reply) => {
    // Loopback guard
    if (!opts.skipLoopbackCheck && !isLoopbackAddress(request.ip)) {
      reply.status(403);
      return { error: 'Secrets endpoint is loopback-only' };
    }

    const parsed = secretsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const operator = resolveConnectorSessionUserId(request);
    if (!operator) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }

    const ownerError = requireConnectorWriteOwner(operator);
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    // Allowlist validation
    const updates = new Map<string, string | null>();
    for (const update of parsed.data.updates) {
      const validationError = validateSecretUpdate(update);
      if (validationError) {
        reply.status(400);
        return { error: validationError };
      }
      updates.set(update.name, update.value);
    }

    await applyConnectorSecretUpdates(
      [...updates.entries()].map(([name, value]) => ({ name, value })),
      { envFilePath },
    );

    // Audit log — keys only, never values
    try {
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: {
          target: 'secrets',
          keys: [...updates.keys()],
          operator,
        },
      });
    } catch (err) {
      request.log.warn({ err, keys: [...updates.keys()] }, 'secrets config audit append failed');
    }

    return { ok: true };
  });
}
