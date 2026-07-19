/**
 * F257 V2/Phase B — MCP client-layer guard rejection ingest (AC-B1 dual entry).
 *
 * MCP-local fail-closed rejections (e.g. cross_post_message without routing
 * credentials) never reach the API route that would normally emit a guard
 * rejection event — without this ingest they are invisible to the harness
 * ledger. The MCP layer reports them here fire-and-forget (fail-open on the
 * client side; see packages/mcp-server/src/tools/guard-rejection-report.ts).
 *
 * Trust boundary (V1 three-axis provenance discipline):
 * - catId / threadId / invocationId come from the AUTH RECORD, never from
 *   the payload — self-reported identity would allow impersonated pot
 *   accounting.
 * - guardId must be in the ledger registry whitelist — an arbitrary
 *   client-supplied guardId could poison pot attribution.
 * - eventId / timestamp are server-generated (client clocks untrusted).
 *
 * Path lives under /api/callbacks/ so the existing callback auth preHandler
 * chain decorates the request and auth-failure telemetry (which assumes the
 * /api/callbacks/ prefix) stays coherent.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';
import { GUARD_LEDGER_IDS, ledgerIdForGuard } from '../infrastructure/harness-eval/guard-ledger-registry.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';

/** Kinds the MCP client layer can legitimately produce locally. */
const mcpGuardRejectionSchema = z.object({
  kind: z.enum(['http_schema_reject', 'http_policy_reject']),
  guardId: z.string().min(1).max(120),
  sourceTool: z.string().min(1).max(120),
  normalizedReason: z.string().min(1).max(200),
});

export interface GuardRejectionIngestDeps {
  guardRejectionLog?: GuardRejectionEventLog | undefined;
}

export function registerCallbackGuardRejectionRoutes(app: FastifyInstance, deps: GuardRejectionIngestDeps): void {
  app.post('/api/callbacks/guard-rejections', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return; // 401 already sent by requireCallbackAuth
    const actor = deriveCallbackActor(record);

    const parsed = mcpGuardRejectionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'invalid guard rejection payload',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      };
    }

    // Fail-closed whitelist — unregistered guardIds must not enter the ledger.
    if (!(parsed.data.guardId in GUARD_LEDGER_IDS)) {
      reply.status(400);
      return {
        error: `unregistered guardId '${parsed.data.guardId}' — register it in guard-ledger-registry first`,
        registered: Object.keys(GUARD_LEDGER_IDS),
      };
    }

    const ledgerId = ledgerIdForGuard(parsed.data.guardId);
    const eventId = randomUUID();
    if (deps.guardRejectionLog) {
      // invocationId is first-hand (auth-token bound) → confidence 'exact'.
      await deps.guardRejectionLog.append({
        eventId,
        ledgerId,
        kind: parsed.data.kind,
        threadId: actor.threadId,
        catId: actor.catId as string,
        guardId: parsed.data.guardId,
        invocationId: record.invocationId,
        sourceTool: parsed.data.sourceTool,
        normalizedReason: parsed.data.normalizedReason,
        layer: 'mcp-client',
        timestamp: Date.now(),
        correlationConfidence: 'exact',
      });
    }
    reply.status(202);
    return { accepted: true, eventId, ledgerId };
  });
}
