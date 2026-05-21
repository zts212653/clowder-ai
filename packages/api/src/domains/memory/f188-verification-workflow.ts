import type Database from 'better-sqlite3';

export interface VerificationAction {
  anchor: string;
  action: 'confirm' | 'mark_stale' | 'escalate' | 'dismiss_review';
  actor: string;
}

interface ActionResult {
  ok: boolean;
  error?: string;
  previousStatus?: string | null;
  newStatus?: string | null;
}

const VALID_PRECONDITIONS: Record<string, Set<string | null>> = {
  confirm: new Set(['needs_review']),
  mark_stale: new Set(['needs_review', 'reviewed', 'trusted_legacy', 'dismissed']),
  escalate: new Set(['needs_review', 'trusted_legacy']),
  dismiss_review: new Set(['needs_review']),
};

export function executeVerificationAction(db: Database.Database, action: VerificationAction): ActionResult {
  const row = db.prepare('SELECT review_status, verified_at FROM evidence_docs WHERE anchor = ?').get(action.anchor) as
    | { review_status: string | null; verified_at: string | null }
    | undefined;

  if (!row) {
    return { ok: false, error: `Anchor not found: ${action.anchor}` };
  }

  const validPre = VALID_PRECONDITIONS[action.action];
  if (!validPre?.has(row.review_status)) {
    return {
      ok: false,
      error: `Invalid precondition: review_status=${row.review_status} for action=${action.action}`,
    };
  }

  const previousStatus = row.review_status;
  let newStatus: string | null;
  let verifiedAt: string | null;

  switch (action.action) {
    case 'confirm':
      newStatus = 'reviewed';
      verifiedAt = new Date().toISOString();
      break;
    case 'mark_stale':
      newStatus = 'needs_review';
      verifiedAt = null;
      break;
    case 'escalate':
      newStatus = 'escalated';
      verifiedAt = row.verified_at;
      break;
    case 'dismiss_review':
      newStatus = 'dismissed';
      verifiedAt = row.verified_at;
      break;
  }

  db.prepare('UPDATE evidence_docs SET review_status = ?, verified_at = ? WHERE anchor = ?').run(
    newStatus,
    verifiedAt,
    action.anchor,
  );

  db.prepare(
    `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
     VALUES ('verification_action', 'v1', '{}', ?, ?)`,
  ).run(
    JSON.stringify({
      anchor: action.anchor,
      action: action.action,
      actor: action.actor,
      previousStatus,
      newStatus,
    }),
    new Date().toISOString(),
  );

  return { ok: true, previousStatus, newStatus };
}
