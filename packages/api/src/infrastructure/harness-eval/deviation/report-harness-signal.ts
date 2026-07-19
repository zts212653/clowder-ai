/**
 * F257 V1 — cat_cafe_report_harness_signal server side (§4.8② 语义上报层).
 *
 * Contract single source of truth: T-C (§3.6) — sourceAnchor typed union /
 * 三条服务端校验①②③ / recordedBy+ownerUserId principal 注入 / incidentKey /
 * idempotencyKey scope. Write path is await-append: failures return explicit
 * errors, never fail-open (§4.5-2). Route wiring mirrors
 * callback-runtime-session-routes.ts.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isAuthenticatedOperatorMessage,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { requireCallbackPrincipal } from '../../../routes/callback-auth-prehandler.js';
import type { IDeviationEventLog } from './DeviationEventLog.js';
import {
  type DeviationAnchors,
  type DeviationSourceAnchor,
  type ManualObservationEvent,
  manualIncidentKey,
  V1_REGISTRY_VERSION,
} from './deviation-event.js';

const unitRefShape = z.object({ unitType: z.string().min(1), unitId: z.string().min(1) }).strict();

const attributionShape = z
  .object({
    objectiveId: z.string().min(1),
    unitRefs: z.array(unitRefShape).min(1),
    weight: z.number().gt(0).max(1),
  })
  .strict();

const sourceAnchorShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread_message'), messageId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('operator_confirmation'), confirmationId: z.string().min(1) }).strict(),
]);

/** T-C input contract. `.strict()`: recordedBy/ownerUserId 不是输入字段——出现即拒. */
export const reportHarnessSignalBodySchema = z
  .object({
    sourceAnchor: sourceAnchorShape,
    subjectCatId: z.string().min(1),
    source: z.enum(['operator', 'peer', 'self']),
    note: z.string().min(1),
    attributions: z.array(attributionShape).min(1),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

export interface ReportHarnessSignalDeps {
  messageStore: { getById(id: string): StoredMessage | null | Promise<StoredMessage | null> };
  deviationLog: IDeviationEventLog;
  /** F257 V2 AC-B2: per-pot anomaly-reference stats (optional; skipped when absent). */
  ledgerStats?: import('../guard-ledger-registry.js').GuardLedgerStats;
}

/** Server-trusted identity (T-C: callback principal 注入, 不可自报). */
export interface ReportPrincipal {
  userId: string;
  catId: string;
}

export interface HandlerReply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleReportHarnessSignal(
  deps: ReportHarnessSignalDeps,
  principal: ReportPrincipal,
  rawBody: unknown,
): Promise<HandlerReply> {
  const parsed = reportHarnessSignalBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { status: 400, body: { error: 'invalid_body', message } };
  }
  const body = parsed.data;

  const resolved = await resolveAnchor(deps, principal, body.source, body.sourceAnchor);
  if ('error' in resolved) return resolved.error;

  const event: ManualObservationEvent = {
    kind: 'manual_observation',
    eventId: `dev-${randomUUID()}`,
    timestamp: Date.now(),
    registryVersion: V1_REGISTRY_VERSION,
    incidentKey: manualIncidentKey(principal.userId, body.sourceAnchor, body.subjectCatId, body.attributions),
    ownerUserId: principal.userId,
    attributions: body.attributions,
    anchors: resolved.anchors,
    subjectCatId: body.subjectCatId,
    source: body.source,
    note: body.note,
    sourceAnchor: body.sourceAnchor,
    recordedBy: principal.catId,
  };

  // T-C 幂等: principal+threadId scoped (仅防网络重试)
  const idempotencyKey = body.idempotencyKey
    ? `${principal.catId}:${resolved.anchors.threadId}:${body.idempotencyKey}`
    : undefined;

  const result = await deps.deviationLog.append(event, idempotencyKey ? { idempotencyKey } : undefined);

  // F257 V2 AC-B2: an anomaly report referencing a pot coordinate increments
  // that pot's stats — writeback on the WRITE side (F245 KD-4 keeps the
  // friction pull path read-only). Uses result.eventId (the canonical id even
  // on dedup replay) + SADD, so retries never double-count. Fail-open.
  if (deps.ledgerStats) {
    const { extractLedgerRefs } = await import('../guard-ledger-registry.js');
    for (const ledgerId of extractLedgerRefs(body.note)) {
      // Owner-scoped (sol R2 P1): stats attribution stays within the
      // reporting principal's owner space.
      void deps.ledgerStats.recordAnomalyReference(principal.userId, ledgerId, result.eventId);
    }
  }

  return {
    status: 200,
    body: { outcome: result.outcome, eventId: result.eventId, incidentKey: event.incidentKey },
  };
}

async function resolveAnchor(
  deps: ReportHarnessSignalDeps,
  principal: ReportPrincipal,
  source: 'operator' | 'peer' | 'self',
  anchor: DeviationSourceAnchor,
): Promise<{ anchors: DeviationAnchors } | { error: HandlerReply }> {
  if (anchor.kind === 'operator_confirmation') {
    // T-C ①: V1 has no confirmation store yet (candidate 转正通道 lands with the
    // confirm flow) — no such entity can exist, so the existence check fails honestly.
    return {
      error: {
        status: 404,
        body: {
          error: 'anchor_not_found',
          message: 'operator_confirmation anchors have no backing store in V1 — anchor a thread_message instead',
        },
      },
    };
  }

  const msg = await deps.messageStore.getById(anchor.messageId);
  // ① entity exists (tombstone = content wiped → cannot serve as evidence anchor)
  if (!msg || msg._tombstone) {
    return { error: { status: 404, body: { error: 'anchor_not_found' } } };
  }
  // ② anchor 与 authenticated ownerUserId 同域
  if (msg.userId !== principal.userId) {
    return { error: { status: 403, body: { error: 'anchor_owner_mismatch' } } };
  }
  // ③ source=operator ⇒ anchor is a fresh authenticated owner assertion.
  // Provenance is the identity authority; nullable catId/source alone also
  // match system surfaces and derived branch copies.
  if (source === 'operator' && !isAuthenticatedOperatorMessage(msg)) {
    return { error: { status: 403, body: { error: 'anchor_author_not_operator' } } };
  }
  return { anchors: { threadId: msg.threadId, messageId: msg.id } };
}

export interface ReportHarnessSignalRouteOptions {
  messageStore: ReportHarnessSignalDeps['messageStore'];
  /** undefined when Redis is absent — route degrades to explicit 503 (no fail-open). */
  deviationLog?: IDeviationEventLog;
  /** F257 V2 AC-B2: pot stats writeback (sol P1-2 — this MUST reach the handler). */
  ledgerStats?: ReportHarnessSignalDeps['ledgerStats'];
}

export function registerReportHarnessSignalRoute(app: FastifyInstance, opts: ReportHarnessSignalRouteOptions): void {
  app.post('/api/callbacks/harness-signals/report', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (!opts.deviationLog) {
      reply.status(503);
      return { error: 'deviation_log_unavailable', message: 'DeviationEventLog requires Redis' };
    }
    const res = await handleReportHarnessSignal(
      {
        messageStore: opts.messageStore,
        deviationLog: opts.deviationLog,
        // sol P1-2: this adapter previously dropped ledgerStats — reports
        // returned 200 with zero stats writes.
        ...(opts.ledgerStats ? { ledgerStats: opts.ledgerStats } : {}),
      },
      { userId: principal.userId, catId: principal.catId },
      request.body,
    );
    reply.status(res.status);
    return res.body;
  });
}
