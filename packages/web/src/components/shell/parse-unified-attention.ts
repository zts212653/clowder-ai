import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';

/**
 * Structural guard for `GET /api/concierge/work/decisions?view=unified` (F310 delivery record).
 *
 * F310 deliberately does not export a runtime schema for the whole response (only the upstream source schemas), so this
 * checks the fields the 小信箱 reads — version, status, identity, per-source state, consistency, item keys and kinds,
 * `totalCount`, page — and nothing else. Extra fields pass through. A body that fails here is never an "empty success":
 * the caller treats it as unavailable.
 *
 * Approval rows are NOT re-validated against ApprovalHubItem here: F310 already runs the canonical approval schema on
 * the producer side, and the canonical card renders them. This guard only refuses a row that has no addressable
 * approval at all.
 */

const OVERALL_STATUS = new Set(['available', 'partial', 'unavailable']);
const SOURCE_STATUS = new Set(['available', 'unavailable', 'unauthenticated', 'forbidden', 'invalid']);
const EXHAUSTIVENESS = new Set(['complete', 'partial', 'unknown']);
const ITEM_KIND = new Set(['approval', 'judgment', 'repair']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSourceRead(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    SOURCE_STATUS.has(value.status) &&
    typeof value.exhaustiveness === 'string' &&
    EXHAUSTIVENESS.has(value.exhaustiveness)
  );
}

function isItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonBlankString(value.decisionRef)) return false;
  if (typeof value.kind !== 'string' || !ITEM_KIND.has(value.kind)) return false;
  if (typeof value.summary !== 'string') return false;
  if (!Array.isArray(value.linkedNeedsMe)) return false;
  if (value.approval === undefined) return true;
  return isRecord(value.approval) && isNonBlankString(value.approval.proposalId);
}

function hasOwnerIdentity(body: Record<string, unknown>): boolean {
  return isRecord(body.identity) && isNonBlankString(body.identity.ownerUserId);
}

function hasSources(body: Record<string, unknown>): boolean {
  return isRecord(body.sources) && isSourceRead(body.sources.approvals) && isSourceRead(body.sources.needsMe);
}

function hasConsistency(body: Record<string, unknown>): boolean {
  return (
    isRecord(body.consistency) && (body.consistency.state === 'verified' || body.consistency.state === 'uncertain')
  );
}

function hasValidTotal(body: Record<string, unknown>): boolean {
  return body.totalCount === undefined || (Number.isInteger(body.totalCount) && (body.totalCount as number) >= 0);
}

function hasPage(body: Record<string, unknown>): boolean {
  return isRecord(body.page) && typeof body.page.hasMore === 'boolean';
}

export function parseUnifiedAttentionRead(body: unknown): UnifiedAttentionReadV1 | null {
  if (!isRecord(body) || body.version !== 1 || body.scope !== 'owner_all_projects') return null;
  if (typeof body.status !== 'string' || !OVERALL_STATUS.has(body.status)) return null;
  if (!Array.isArray(body.items) || !body.items.every(isItem)) return null;
  const structurallyValid =
    hasOwnerIdentity(body) && hasSources(body) && hasConsistency(body) && hasValidTotal(body) && hasPage(body);
  return structurallyValid ? (body as unknown as UnifiedAttentionReadV1) : null;
}
