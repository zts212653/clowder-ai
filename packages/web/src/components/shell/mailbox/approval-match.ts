import type { ApprovalHubItem, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import { APPROVAL_FEATURES } from '@/lib/approval-features';
import { decidesOnOriginCard } from './original-place';

/**
 * F322 S3-2b-1a: when the 待办 panel may hand an approval to its original card.
 *
 * The panel shows what the unified read says. The original card acts through the Approval Hub store, which looks the
 * proposal up in its own `items` for the endpoint, the request body and the lifecycle. Those are two copies of one fact
 * read at different moments, so the card is hosted only when the store's copy is the same decision the user is looking at.
 * "Same" means the proposal, the producer, the owner (the read's verified identity: the read carries none on the item),
 * the version, the lifecycle, the ability to act, not expired, and the credentials the producer itself checks when the
 * button is pressed — equal createdAt and lifecycle do not make two F292 revisions or two F260 fingerprints the same.
 *
 * Anything that differs, is missing, or cannot be told is unmatched. There is no default match.
 */
export type ApprovalMismatch =
  | { reason: 'not_in_store' }
  | { reason: 'owner' }
  | { reason: 'identity'; field: 'createdAt' }
  | { reason: 'capability'; field: 'decisionMode' | 'inlineApprovable' }
  | { reason: 'lifecycle'; field: 'resolution' | 'materialization' }
  | { reason: 'version'; field: 'expiresAt' | 'summary' }
  | { reason: 'expired' }
  | { reason: 'credentials'; field: string };

export type HostedApprovalMatch =
  | { kind: 'matched'; item: ApprovalHubItem }
  | ({ kind: 'unmatched' } & ApprovalMismatch);

export interface HostedApprovalMatchInput {
  /** The approval as the unified read carries it. */
  read: UnifiedAttentionVisibleApproval;
  /** The read's verified identity: the owner the read's rows belong to. */
  readOwnerUserId: string;
  /** What the Approval Hub store currently holds, the copy its actions will act on. */
  storeItems: readonly ApprovalHubItem[];
  /** The moment of asking. Expiry is judged here, not when the card was drawn. */
  now: number;
}

/**
 * The unified read's wire decoder admits any row that carries an address, and the Hub store's copy is not decoded here at all;
 * TypeScript's types do not exist at runtime. So every structure this module dereferences is checked first, and one that is
 * missing or unreadable is "cannot be told" (unmatched), never an exception and never a default.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function lifecycleState(item: { materialization?: unknown }): string | null {
  const { materialization } = item;
  return isRecord(materialization) && typeof materialization.state === 'string' ? materialization.state : null;
}

function stringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return new Set(value as string[]);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

interface ConflictCredential {
  fingerprint: string;
  allowedActions: Set<string>;
  canonicalReplacementRequiredFor: Set<string>;
}

/** `absent` is a plain proposal with nothing to compare; `unreadable` is something present that cannot be told. */
function conflictCredential(detail: Record<string, unknown>): ConflictCredential | 'absent' | 'unreadable' {
  const conflict = detail.conflict;
  if (conflict === undefined || conflict === null) return 'absent';
  if (typeof conflict !== 'object') return 'unreadable';
  const { fingerprint, allowedActions, canonicalReplacementRequiredFor } = conflict as Record<string, unknown>;
  const allowed = stringSet(allowedActions);
  const required = stringSet(canonicalReplacementRequiredFor);
  if (typeof fingerprint !== 'string' || !allowed || !required) return 'unreadable';
  return { fingerprint, allowedActions: allowed, canonicalReplacementRequiredFor: required };
}

/** F292 presents its `detail.revision` as `expectedRevision`; both copies must carry the same readable integer. */
function meetingMismatch(read: Record<string, unknown>, store: Record<string, unknown>): string | null {
  const same = Number.isSafeInteger(read.revision) && read.revision === store.revision;
  return same ? null : 'revision';
}

function entityMismatch(read: Record<string, unknown>, store: Record<string, unknown>): string | null {
  const a = conflictCredential(read);
  const b = conflictCredential(store);
  if (a === 'unreadable' || b === 'unreadable') return 'conflict';
  if (a === 'absent' && b === 'absent') return null;
  if (a === 'absent' || b === 'absent') return 'conflict';
  if (a.fingerprint !== b.fingerprint) return 'fingerprint';
  if (!sameSet(a.allowedActions, b.allowedActions)) return 'allowedActions';
  if (!sameSet(a.canonicalReplacementRequiredFor, b.canonicalReplacementRequiredFor)) {
    return 'canonicalReplacementRequiredFor';
  }
  return null;
}

function personMemoryMismatch(read: Record<string, unknown>, store: Record<string, unknown>): string | null {
  const a = stringSet(read.remainingDraftIds);
  const b = stringSet(store.remainingDraftIds);
  return a && b && sameSet(a, b) ? null : 'remainingDraftIds';
}

/** The first credential the producer would check at press time that the two copies do not share; null when they share it. */
function credentialMismatch(read: UnifiedAttentionVisibleApproval, store: ApprovalHubItem): string | null {
  if (read.sourceFeatureId === 'F292') return meetingMismatch(read.detail, store.detail);
  if (read.sourceFeatureId === 'F260') return entityMismatch(read.detail, store.detail);
  if (read.sourceFeatureId === 'F276' && read.decisionMode === 'claim-select') {
    return personMemoryMismatch(read.detail, store.detail);
  }
  return null;
}

interface MatchContext {
  readOwnerUserId: string;
  now: number;
}

type Check = (
  read: UnifiedAttentionVisibleApproval,
  store: ApprovalHubItem,
  context: MatchContext,
) => ApprovalMismatch | null;

const ownerCheck: Check = (_read, store, { readOwnerUserId }) =>
  typeof readOwnerUserId !== 'string' || readOwnerUserId.trim() === '' || store.ownerUserId !== readOwnerUserId
    ? { reason: 'owner' }
    : null;

// Two copies that are equally unreadable are not "the same": a time that is not a time cannot identify a decision.
const identityCheck: Check = (read, store) =>
  isTime(store.createdAt) && isTime(read.createdAt) && store.createdAt === read.createdAt
    ? null
    : { reason: 'identity', field: 'createdAt' };

const capabilityCheck: Check = (read, store) => {
  if (store.decisionMode !== read.decisionMode) return { reason: 'capability', field: 'decisionMode' };
  if (store.inlineApprovable !== read.inlineApprovable) return { reason: 'capability', field: 'inlineApprovable' };
  return null;
};

const lifecycleCheck: Check = (read, store) => {
  if (store.resolution !== read.resolution) return { reason: 'lifecycle', field: 'resolution' };
  const readState = lifecycleState(read);
  const storeState = lifecycleState(store);
  return readState === null || storeState === null || readState !== storeState
    ? { reason: 'lifecycle', field: 'materialization' }
    : null;
};

const expiryReadable = (value: unknown) => value === undefined || isTime(value);

const versionCheck: Check = (read, store) => {
  if (!expiryReadable(store.expiresAt) || !expiryReadable(read.expiresAt) || store.expiresAt !== read.expiresAt) {
    return { reason: 'version', field: 'expiresAt' };
  }
  return store.summary === read.summary ? null : { reason: 'version', field: 'summary' };
};

// The card itself says "expired" only strictly after expiresAt; the instant of expiry is still decidable.
const expiryCheck: Check = (_read, store, { now }) =>
  store.expiresAt !== undefined && store.expiresAt < now ? { reason: 'expired' } : null;

// The card reads its detail whatever the producer, so a copy without a detail object is not one it can be shown.
const credentialsCheck: Check = (read, store) => {
  if (!isRecord(read.detail) || !isRecord(store.detail)) return { reason: 'credentials', field: 'detail' };
  const field = credentialMismatch(read, store);
  return field ? { reason: 'credentials', field } : null;
};

/** In the order a reader would ask: whose, which, what it can do, where it is in its life, which version, still alive, the credentials. */
const CHECKS: readonly Check[] = [
  ownerCheck,
  identityCheck,
  capabilityCheck,
  lifecycleCheck,
  versionCheck,
  expiryCheck,
  credentialsCheck,
];

export function matchHostedApproval(input: HostedApprovalMatchInput): HostedApprovalMatch {
  const { read, readOwnerUserId, storeItems, now } = input;
  const store = storeItems.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.proposalId === read.proposalId &&
      candidate.sourceFeatureId === read.sourceFeatureId,
  );
  if (!store) return { kind: 'unmatched', reason: 'not_in_store' };
  for (const check of CHECKS) {
    const mismatch = check(read, store, { readOwnerUserId, now });
    if (mismatch) return { kind: 'unmatched', ...mismatch };
  }
  return { kind: 'matched', item: store };
}

/**
 * Whether an approval is one the panel can hand to its original card at all. A settled proposal has nothing left to decide;
 * a producer whose decision belongs on its own origin card is never decided here; one this build does not know cannot be
 * shown honestly; and what is neither inline-approvable nor one of the producers that decide in their own card has no
 * action to host.
 */
export function isHostableApproval(approval: UnifiedAttentionVisibleApproval): boolean {
  if (!isRecord(approval) || approval.resolution !== 'open') return false;
  if (!(approval.sourceFeatureId in APPROVAL_FEATURES)) return false;
  if (decidesOnOriginCard(approval.sourceFeatureId)) return false;
  return (
    approval.inlineApprovable || approval.decisionMode === 'claim-select' || approval.decisionMode === 'meeting-intake'
  );
}
