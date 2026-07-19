/**
 * F257 V2/Phase B — MCP client-layer guard rejection ingest + ledger query
 * surface (AC-B1 dual entry + "queryable by ledger id").
 *
 * POST: MCP-local fail-closed rejections (e.g. cross_post_message without
 * routing credentials) never reach the API route that would normally emit a
 * guard rejection event — the MCP layer reports them here fire-and-forget
 * (fail-open client side; see packages/mcp-server/src/tools/guard-rejection-report.ts).
 *
 * GET: the AC-B1 acceptance step is "trigger a 429 + an MCP-local reject →
 * query BY LEDGER ID returns both" — this is that consumer surface, also
 * carrying AC-B2 pot stats (anomalyRefCount + how_counted).
 *
 * Trust boundary (V1 three-axis provenance discipline; sol review P1-1/P1-3):
 * - BOTH principal kinds accepted (requireCallbackPrincipal): invocation
 *   principals carry trusted threadId/invocationId; agent-key principals
 *   carry NO thread binding — their thread coordinate is taken from the
 *   payload but VERIFIED through the scoped-thread resolver (owner check),
 *   degrading to 'unknown' (coalescer untrusted-key isolation) on any
 *   failure. Identity (catId/userId) always comes from the principal.
 * - guardId whitelist uses Object.hasOwn — `in` walks the prototype chain
 *   and would accept 'toString'/'constructor' and mint function ledgerIds.
 * - eventId / timestamp are server-generated (client clocks untrusted).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';
import {
  GUARD_LEDGER_IDS,
  type GuardLedgerStats,
  isRegisteredGuardId,
  ledgerIdForGuard,
} from '../infrastructure/harness-eval/guard-ledger-registry.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { resolveScopedThreadId } from './callback-scope-helpers.js';

/** Kinds the MCP client layer can legitimately produce locally. */
const mcpGuardRejectionSchema = z.object({
  kind: z.enum(['http_schema_reject', 'http_policy_reject']),
  guardId: z.string().min(1).max(120),
  sourceTool: z.string().min(1).max(120),
  normalizedReason: z.string().min(1).max(200),
  /**
   * Thread coordinate for agent-key callers (no thread binding in the
   * principal). Verified via scoped-thread resolver — never trusted as-is.
   * Ignored for invocation principals (their principal.threadId wins).
   */
  threadId: z.string().min(1).max(200).optional(),
});

const ledgerQuerySchema = z.object({
  ledgerId: z.string().min(1).max(200),
  sinceMs: z.coerce.number().int().positive().optional(),
  untilMs: z.coerce.number().int().positive().optional(),
});

export interface GuardRejectionRouteDeps {
  guardRejectionLog?: GuardRejectionEventLog | undefined;
  /** AC-B2 pot stats — optional (absent without Redis). */
  ledgerStats?: GuardLedgerStats | undefined;
  /** Scoped-thread verification for agent-key thread coordinates. */
  threadStore?: Pick<IThreadStore, 'get' | 'list'> | undefined;
}

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

export function registerCallbackGuardRejectionRoutes(app: FastifyInstance, deps: GuardRejectionRouteDeps): void {
  app.post('/api/callbacks/guard-rejections', async (request, reply) => {
    // sol P1-1: requireCallbackPrincipal accepts BOTH invocation and
    // agent-key principals — requireCallbackAuth rejected agent-key callers
    // with 401, silently dropping the exact persistent-MCP scenario AC-B1
    // dual entry exists for.
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return; // 401 already sent

    const parsed = mcpGuardRejectionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'invalid guard rejection payload',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      };
    }

    // sol P1-3: Object.hasOwn — `guardId in GUARD_LEDGER_IDS` accepted
    // prototype keys ('toString', 'constructor') and minted function-typed
    // ledgerIds into the event log and dropped ledgerId from the response.
    if (!isRegisteredGuardId(parsed.data.guardId)) {
      reply.status(400);
      return {
        error: `unregistered guardId '${parsed.data.guardId}' — register it in guard-ledger-registry first`,
        registered: Object.keys(GUARD_LEDGER_IDS),
      };
    }

    // Provenance per principal kind (sol P1-1 explicit contract):
    // - invocation: threadId + invocationId first-hand → 'exact'
    // - agent_key: payload thread coordinate verified via scoped resolver
    //   (owner check); verification failure degrades to 'unknown' rather than
    //   rejecting — the observation must not be lost, but it must never be
    //   attributed to a thread the caller cannot access. No invocation → 'window'.
    let threadId: string;
    let invocationId: string;
    let correlationConfidence: 'exact' | 'window';
    if (principal.kind === 'invocation') {
      threadId = principal.threadId;
      invocationId = principal.invocationId;
      correlationConfidence = 'exact';
    } else {
      invocationId = 'unknown';
      correlationConfidence = 'window';
      if (parsed.data.threadId && deps.threadStore) {
        // sol R2 P1-2: resolver infra failures (threadStore throw) must NOT
        // 500 the ingest — the observation would be lost. Degrade to
        // 'unknown' with a loud warning; attribution integrity is preserved
        // (unknown never merges in the coalescer).
        try {
          const resolved = await resolveScopedThreadId(
            { threadId: '', userId: principal.userId },
            parsed.data.threadId,
            { threadStore: deps.threadStore },
          );
          threadId = resolved.ok ? resolved.threadId : 'unknown';
        } catch (err) {
          request.log.warn(
            { err, requestedThreadId: parsed.data.threadId },
            'F257 guard-rejection ingest: scoped-thread resolver failed — degrading to unknown',
          );
          threadId = 'unknown';
        }
      } else {
        threadId = 'unknown';
      }
    }

    const ledgerId = ledgerIdForGuard(parsed.data.guardId);
    const eventId = randomUUID();
    if (deps.guardRejectionLog) {
      await deps.guardRejectionLog.append({
        eventId,
        ledgerId,
        kind: parsed.data.kind,
        threadId,
        catId: principal.catId as string,
        guardId: parsed.data.guardId,
        ownerUserId: principal.userId,
        invocationId,
        sourceTool: parsed.data.sourceTool,
        normalizedReason: parsed.data.normalizedReason,
        layer: 'mcp-client',
        timestamp: Date.now(),
        correlationConfidence,
      });
    }
    reply.status(202);
    return { accepted: true, eventId, ledgerId };
  });

  // sol P1-4: the ledgerId consumer surface. AC-B1 acceptance: rejection
  // response hands the cat a ledgerId → this endpoint answers "what has this
  // pot intercepted" (events across layers) + AC-B2 stats with how_counted.
  app.get('/api/callbacks/guard-rejections', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = ledgerQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'invalid ledger query',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      };
    }
    if (!deps.guardRejectionLog) {
      reply.status(503);
      return { error: 'guard_rejection_log_unavailable', message: 'GuardRejectionEventLog requires Redis' };
    }

    // +1: the window is half-open [since, until) — without it, a rejection
    // emitted in the SAME millisecond as the query (the "I just got rejected,
    // what is this pot" flow) would be invisible.
    const until = parsed.data.untilMs ?? Date.now() + 1;
    const since = parsed.data.sinceMs ?? until - SEVEN_DAYS_MS;
    // sol R2 P1-1 (owner scope) + P2 (no fail-open masquerade): the query is
    // HARD-scoped to the caller's ownerUserId — no principal can read another
    // owner's thread/cat/invocation data. Strict variant + explicit 503:
    // "ledger unavailable" must never look like "the pot never fired"
    // (same discipline as V1 unmeasurable-vs-dormant).
    try {
      const { events, truncated } = await deps.guardRejectionLog.queryWindowStrictComplete({
        since,
        until,
        ledgerId: parsed.data.ledgerId,
        ownerUserId: principal.userId,
      });
      const anomalyRefCount = deps.ledgerStats
        ? await deps.ledgerStats.anomalyReferenceCount(principal.userId, parsed.data.ledgerId)
        : 0;

      return {
        ledgerId: parsed.data.ledgerId,
        window: { sinceMs: since, untilMs: until },
        events,
        truncated,
        stats: {
          anomalyRefCount,
          howCounted:
            'scard guard-ledger:stats:{ownerUserId}:{ledgerId}:anomaly-refs — distinct deviation eventIds whose note references this pot',
        },
      };
    } catch (err) {
      request.log.warn({ err, ledgerId: parsed.data.ledgerId }, 'F257 guard-rejection query failed (infra)');
      reply.status(503);
      return { error: 'guard_rejection_query_failed', message: 'ledger unavailable — not a zero-events result' };
    }
  });
}
