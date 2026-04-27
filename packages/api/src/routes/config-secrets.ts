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
import { isConnectorSecret } from '../config/connector-secrets-allowlist.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { normalizeTelegramBotToken } from '../infrastructure/connectors/telegram-token.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

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

function validateSecretUpdate(update: { name: string; value: string | null }): string | null {
  if (!isConnectorSecret(update.name)) return `'${update.name}' is not in connector secrets allowlist`;
  if (
    update.name === 'TELEGRAM_BOT_TOKEN' &&
    update.value != null &&
    update.value !== '' &&
    normalizeTelegramBotToken(update.value) == null
  ) {
    return 'TELEGRAM_BOT_TOKEN must look like a Telegram BotFather token (<digits>:<token>)';
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

    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
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
