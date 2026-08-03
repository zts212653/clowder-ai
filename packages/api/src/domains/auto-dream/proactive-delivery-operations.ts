import type {
  AttachCanonicalMessageInput,
  AttachCanonicalMessageResult,
  ProactiveSurfaceRef,
  ProactiveVisitRecord,
} from './proactive-relationship-contract.js';
import { requireProactiveVisit } from './proactive-relationship-operations.js';
import { consumeBudgetClaim } from './proactive-visit-operations.js';
import type { AutoDreamStoreContext } from './store-context.js';
import { insertAutoDreamEvent } from './store-context.js';
import { rowToProactiveVisit } from './store-rows.js';
import { AutoDreamStoreError } from './store-types.js';

type DbRow = Record<string, unknown>;

export function getProactiveVisit(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  visitId: string,
): ProactiveVisitRecord {
  return requireProactiveVisit(context, ownerUserId, catId, visitId);
}

export function listPendingCanonicalDeliveries(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  limit = 100,
): ProactiveVisitRecord[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AutoDreamStoreError('INVALID_PROACTIVE_RELATIONSHIP', 'pending delivery limit must be 1..500', 400);
  }
  const rows = context.db
    .prepare(
      `SELECT * FROM proactive_visits
       WHERE owner_user_id = ?
         AND pending_message_body IS NOT NULL
         AND canonical_message_id IS NULL
         AND status IN ('reserved', 'projected', 'echoed')
       ORDER BY created_at, visit_id LIMIT ?`,
    )
    .all(ownerUserId, limit) as DbRow[];
  return rows.map(rowToProactiveVisit);
}

export function attachCanonicalMessage(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  rawInput: AttachCanonicalMessageInput,
): AttachCanonicalMessageResult {
  const input = normalizeAttachInput(rawInput);
  return context.db.transaction(() => {
    const visit = requireProactiveVisit(context, ownerUserId, catId, input.visitId);
    if (input.threadId !== visit.homeThreadId) {
      throw new AutoDreamStoreError(
        'PROACTIVE_HOME_MISMATCH',
        'canonical proactive message must use the visit home thread',
        409,
      );
    }
    if (visit.canonicalMessageId) {
      if (visit.canonicalMessageId === input.messageId && visit.canonicalMessageThreadId === input.threadId) {
        return { visit, attached: false };
      }
      throw new AutoDreamStoreError('PROACTIVE_CANONICAL_MESSAGE_CONFLICT', 'visit already has another message', 409);
    }
    if (!visit.pendingMessageBody || visit.status === 'cancelled_unseen' || visit.status === 'settled') {
      throw new AutoDreamStoreError('PROACTIVE_DELIVERY_NOT_PENDING', 'visit has no pending canonical delivery', 409);
    }

    const now = context.now();
    if (visit.budgetClaimState === 'claimed') consumeBudgetClaim(context, visit, now);
    const surface: ProactiveSurfaceRef = { kind: 'home_message', refId: input.messageId };
    const projectedSurfaces = visit.projectedSurfaces.some(
      (existing) => existing.kind === surface.kind && existing.refId === surface.refId,
    )
      ? visit.projectedSurfaces
      : [...visit.projectedSurfaces, surface];
    context.db
      .prepare(
        `UPDATE proactive_visits
         SET status = CASE WHEN status = 'reserved' THEN 'projected' ELSE status END,
             budget_claim_state = CASE WHEN budget_claim_state = 'claimed' THEN 'consumed' ELSE budget_claim_state END,
             pending_message_body = NULL, canonical_message_thread_id = ?, canonical_message_id = ?,
             projected_surfaces_json = ?, updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND visit_id = ? AND canonical_message_id IS NULL`,
      )
      .run(input.threadId, input.messageId, JSON.stringify(projectedSurfaces), now, ownerUserId, catId, visit.visitId);
    context.db
      .prepare(
        `UPDATE proactive_intents
         SET status = CASE WHEN status = 'visit_reserved' THEN 'projected' ELSE status END, updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND intent_id = ?`,
      )
      .run(now, ownerUserId, catId, visit.intentId);
    insertAutoDreamEvent(context, ownerUserId, catId, visit.runId, 'proactive_message_attached', {
      intentId: visit.intentId,
      visitId: visit.visitId,
      messageId: input.messageId,
      outcome: 'projected',
    });
    return { visit: requireProactiveVisit(context, ownerUserId, catId, visit.visitId), attached: true };
  })();
}

function normalizeAttachInput(input: AttachCanonicalMessageInput): AttachCanonicalMessageInput {
  const normalized = {
    visitId: typeof input.visitId === 'string' ? input.visitId.trim() : '',
    threadId: typeof input.threadId === 'string' ? input.threadId.trim() : '',
    messageId: typeof input.messageId === 'string' ? input.messageId.trim() : '',
  };
  if (!normalized.visitId || !normalized.threadId || !normalized.messageId) {
    throw new AutoDreamStoreError(
      'INVALID_PROACTIVE_RELATIONSHIP',
      'visitId, threadId and messageId are required',
      400,
    );
  }
  return normalized;
}
