/**
 * Config Secrets Route — F136 Phase 2
 *
 * POST /api/config/secrets — write connector tokens via Hub config wizard.
 * Allowlist-gated, loopback-guarded, audit-logged (keys only, never values).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { isConnectorSecret } from '../config/connector-secrets-allowlist.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { applyEnvUpdatesToFile } from './config.js';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

function resolveOperator(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (typeof first === 'string' && first.trim().length > 0) return first.trim();
  }
  return null;
}

export async function configSecretsRoutes(app: FastifyInstance, opts: ConfigSecretsRoutesOptions = {}): Promise<void> {
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const projectRoot = resolveActiveProjectRoot();
  const envFilePath = opts.envFilePath ?? resolve(projectRoot, '.env');

  app.post('/api/config/secrets', async (request, reply) => {
    // Loopback guard
    if (!opts.skipLoopbackCheck && !LOOPBACK_ADDRS.has(request.ip)) {
      reply.status(403);
      return { error: 'Secrets endpoint is loopback-only' };
    }

    const parsed = secretsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    // Allowlist validation
    const updates = new Map<string, string | null>();
    for (const update of parsed.data.updates) {
      if (!isConnectorSecret(update.name)) {
        reply.status(400);
        return { error: `'${update.name}' is not in connector secrets allowlist` };
      }
      updates.set(update.name, update.value);
    }

    // Snapshot old values for no-op detection
    const oldValues = new Map<string, string | undefined>();
    for (const name of updates.keys()) {
      oldValues.set(name, process.env[name]);
    }

    // Write .env file
    const current = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
    const next = applyEnvUpdatesToFile(current, updates);
    writeFileSync(envFilePath, next, 'utf8');

    // Update process.env
    for (const [name, value] of updates) {
      if (value == null || value === '') delete process.env[name];
      else process.env[name] = value;
    }

    // Emit event only if at least one key actually changed
    const changedKeys = [...updates.entries()]
      .filter(([name, value]) => (value ?? '') !== (oldValues.get(name) ?? ''))
      .map(([name]) => name);
    if (changedKeys.length > 0) {
      configEventBus.emitChange({
        source: 'secrets',
        scope: 'key',
        changedKeys,
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
    }

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
