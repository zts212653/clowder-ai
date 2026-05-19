/**
 * F194: Invocation Liveness Canonical Read Model
 *
 * Read-only helper that answers "which invocations are live for (threadId, userId)?"
 * by reconciling three independent stores with non-equivalent semantics:
 *
 * - InvocationTracker  → per-process control plane (AbortController) — NOT a lifecycle SoT
 * - InvocationRecord   → cross-process lifecycle SoT (status='running'/'done'/...) — may be zombie
 * - DraftStore         → 300s TTL content cache; draft.updatedAt is the freshness proxy
 *
 * Decision table (KD-3, KD-6 + R1 P1-1/P1-2 from 砚砚 review 2026-05-07):
 *
 * | record  | tracker          | draft fresh? | result                                                  |
 * |---------|------------------|--------------|---------------------------------------------------------|
 * | running | active+assoc     | —            | active source='record+tracker' degraded=false           |
 * | running | active no assoc  | yes          | active source='record+draft' degraded=true              |
 * |         |                  |              | reason='record_running_with_fresh_draft'                |
 * | running | missing          | yes          | active source='record+draft' degraded=true              |
 * | running | —                | no, age<=th  | active source='record-only' degraded=true               |
 * |         |                  |              | reason='liveness_pending' (grace window)                |
 * | running | —                | no, age>th   | zombie (not exposed in active[])                        |
 * | absent  | active+draft-assoc | yes        | active source='tracker+draft' degraded=true             |
 * |         |                  |              | reason='tracker_active_missing_record' (recovery path)  |
 * | absent  | other            | —            | drop (orphan filter)                                    |
 * | other   | —                | —            | drop                                                    |
 *
 * **Tracker association rules** (R1 P1-2 + R2 P1 + R3 P1 fix): a tracker slot is single-injectively
 * mapped to at most one invocation per cat — the slot's owner. Strong & weak paths are bound by
 * ownership, not just timing:
 *  - **slot owner** = the cat's earliest-anchored draft (slot was running before/when that draft
 *    was first created → it's the slot that produced this draft). Pre-computed in
 *    `slotClaimedByDraft` (Map<catId, draft>).
 *  - **STRONG (R3 P1)**: only the slot's owner candidate (record+own-draft OR draft-only owner)
 *    may use record+tracker / tracker+draft. Other candidates whose drafts merely overlap the
 *    slot in time get rejected from these tracker-backed sources.
 *  - **WEAK**: same-cat has exactly one running record AND record.createdAt <= slot.startedAt
 *           AND no other draft strongly claims this slot — fallback for records without their own
 *           draft (single-record-per-cat is unambiguous).
 *  R3 P1 closes the loophole where two candidates' drafts both individually anchored the slot in
 *  time but only one was the true owner: timing-only `slotAssocWithDraft` was reverse-claiming.
 *
 * **Enumeration** (R1 P1-1 fix): candidate set = running records ∪ drafts (by invocationId).
 *  Drafts without a record can still surface as live via the 'tracker+draft' fall-back path,
 *  preserving messages.ts:1400-1406 hotfix3 behavior (AC-B5).
 *
 * `record.updatedAt` is NOT a heartbeat — it changes on status transitions only,
 * so we use `draft.updatedAt` as the freshness signal (DraftStore.touch() refreshes
 * on every stream chunk). Zombie threshold defaults to 2× DraftStore TTL = 600s
 * and ONLY applies when no fresh draft exists, so long-running streams are never
 * mistakenly killed.
 */

import type { CatId } from '@cat-cafe/shared';
import type { DraftRecord } from '../../stores/ports/DraftStore.js';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { ActiveSlotInfo } from './InvocationTracker.js';

export const DEFAULT_FRESH_DRAFT_WINDOW_MS = 300_000;
export const DEFAULT_ZOMBIE_GRACE_MS = 600_000;

export type LivenessSource =
  | 'record+tracker'
  | 'record+draft'
  | 'record-only'
  | 'tracker+draft'
  // F194 Phase Z (KD-21): namespace-aware sources — parent recordStore invocation + child registry turn
  | 'parent+child+tracker'
  | 'parent+child-draft';

export type LivenessReason =
  | 'tracker_present'
  | 'record_running_with_fresh_draft'
  | 'liveness_pending'
  | 'tracker_active_missing_record'
  // F194 Phase Z (KD-21/KD-22): parent record + linked child fresh draft = same execution chain
  | 'namespace_chain_active'
  | 'namespace_chain_degraded';

export interface LiveInvocation {
  /** First targetCat or draft catId; null only when record has no targetCats and no draft */
  catId: CatId | null;
  invocationId: string;
  /** Best-effort start time: tracker slot startedAt > draft.createdAt > record.updatedAt */
  startedAt: number;
  source: LivenessSource;
  degraded: boolean;
  reason: LivenessReason;
}

export type ZombieReason =
  | 'no_tracker_no_fresh_draft_age_exceeded'
  // F194 Phase Z (KD-22): cat slot reused by another parent invocation, this parent has no own child draft
  | 'cat_slot_reused_no_self_draft';

export interface ZombieRecord {
  invocationId: string;
  catId: CatId | null;
  recordStatus: 'running';
  recordUpdatedAt: number;
  reason: ZombieReason;
}

export interface LivenessReadResult {
  active: LiveInvocation[];
  /** Detected zombie records — NOT exposed via read endpoints; consumed by cleanup pathway (Phase C) */
  zombies: ZombieRecord[];
}

/** F194 Phase B (Bundle) AC-B11: structured diagnostic events emitted by the helper. */
export type LivenessEventKind = 'liveness_degraded' | 'liveness_pending' | 'record_zombie_detected';

export interface LivenessEvent {
  kind: LivenessEventKind;
  threadId: string;
  userId: string;
  invocationId: string;
  catId: string | null;
  /** Source classification (live entries) or null for zombies. */
  source: LivenessSource | null;
  reason: LivenessReason | ZombieReason;
  /** Diagnostic context (record/draft/tracker state at decision time). */
  recordStatus: 'running' | 'absent';
  recordUpdatedAt: number | null;
  trackerSlotPresent: boolean;
  draftFresh: boolean | null;
  draftAge: number | null;
}

export interface LivenessReadDeps {
  /** Enumerate running InvocationRecords for (threadId, userId). Required so zombies are visible
   *  even when their drafts have already been TTL-reaped (DraftStore TTL < zombie threshold). */
  listRunningRecords: (threadId: string, userId: string) => Promise<InvocationRecord[]> | InvocationRecord[];
  /** InvocationTracker.getActiveSlots(threadId) */
  getActiveSlots: (threadId: string) => ActiveSlotInfo[];
  /** InvocationTracker.getUserId(threadId, catId) — guards against cross-user tracker collisions */
  getTrackerUserId: (threadId: string, catId: string) => string | null;
  /** DraftStore.getByThread(userId, threadId) */
  getDrafts: (userId: string, threadId: string) => Promise<DraftRecord[]> | DraftRecord[];
  /** F194 AC-B12: optional structured event sink. Helper emits liveness_degraded /
   *  liveness_pending / record_zombie_detected at the matching decision points so the
   *  callsite (messages.ts/queue.ts) can route them into a logger. Sink failure must NOT
   *  interrupt the read — exceptions are swallowed. */
  onLog?: (event: LivenessEvent) => void;
  /** F194 Phase Z (KD-21/KD-22, 砚砚 R1 P1-1): namespace bridge — given a child registry
   *  invocationId (used by drafts / per-cat-turn), return its parent recordStore invocationId
   *  + child catId/createdAt. Wraps `InvocationRegistry.getRecord(invocationId)` (which already
   *  has `parentInvocationId` field). When undefined → helper falls back to legacy single-namespace
   *  classification (Phase A/B behavior preserved for callers that haven't wired registry). */
  getTurnInvocation?: (
    invocationId: string,
  ) => Promise<TurnInvocationInfo | null> | TurnInvocationInfo | null | undefined;
  /** F194 Phase Z (KD-22): wraps `InvocationRegistry.getLatestId(threadId, catId)`. Used to
   *  detect cat-slot reuse — when the latest turn for (thread, cat) belongs to a parent OTHER
   *  than this candidate's record, this candidate's chain is dead → instant zombie candidate
   *  (AC-Z2 case γ). When undefined → cat-slot-reuse detection skipped (degrade gracefully). */
  getLatestTurnInvocationId?: (
    threadId: string,
    catId: string,
  ) => Promise<string | null | undefined> | string | null | undefined;
}

/** F194 Phase Z (KD-22): structured turn invocation info returned by getTurnInvocation dep.
 *  parentInvocationId may be absent when invocation is top-level (e.g., scheduled job, no parent chain).
 *  R2 P1-B: userId required so namespace bridge can guard against cross-user cat-slot collisions
 *  (default/system thread is public; getLatestId(threadId, catId) has no user dimension). */
export interface TurnInvocationInfo {
  parentInvocationId: string | undefined;
  threadId: string;
  userId: string;
  catId: string;
  createdAt: number;
}

export interface LivenessReadOptions {
  /** Override Date.now() (tests / deterministic replay) */
  now?: number;
  /** Window where a draft.updatedAt counts as fresh proof of life (default 300_000 ms = DraftStore TTL) */
  freshDraftWindowMs?: number;
  /** Grace window past which a record-only running record (no tracker, no fresh draft) is judged zombie
   *  (default 600_000 ms = 2× DraftStore TTL). Applies ONLY to no-fresh-draft case. */
  zombieGraceMs?: number;
}

type Classification =
  | { kind: 'live'; live: LiveInvocation }
  | { kind: 'zombie'; zombie: ZombieRecord }
  | { kind: 'drop' };

interface ClassifyContext {
  invocationId: string;
  record: InvocationRecord | undefined;
  draft: DraftRecord | undefined;
  slot: ActiveSlotInfo | undefined;
  trackerOwnerMatches: boolean;
  /** R3 P1: cat slot's earliest-anchored draft is THIS candidate's draft (it is the slot's owner).
   *  Required for both strong record+tracker AND tracker+draft fall-back. Implies slot exists,
   *  draft exists, and timing anchored. */
  slotClaimedByThisDraft: boolean;
  /** R2 P1: cat slot is strongly claimed by a draft *other than* this candidate's draft.
   *  Disables weak record-tracker (single-record-per-cat fallback). */
  slotClaimedByOtherDraft: boolean;
  /** Weak record-tracker eligibility: single running record per cat, no draft contention. */
  slotAssocWithRecordSingle: boolean;
  catId: CatId | null;
  now: number;
  freshDraftWindowMs: number;
  zombieGraceMs: number;
}

function tryRecordTracker(ctx: ClassifyContext): LiveInvocation | null {
  // R3 P1: strong path requires THIS candidate to own the slot (earliest-anchored draft).
  // Weak path allows single-record-per-cat fallback when no draft contests the slot.
  const trackerAssoc = ctx.slotClaimedByThisDraft || ctx.slotAssocWithRecordSingle;
  if (!ctx.record || !ctx.slot || !ctx.trackerOwnerMatches || !ctx.catId || !trackerAssoc) return null;
  return {
    catId: ctx.catId,
    invocationId: ctx.invocationId,
    startedAt: ctx.slot.startedAt,
    source: 'record+tracker',
    degraded: false,
    reason: 'tracker_present',
  };
}

function tryTrackerDraft(ctx: ClassifyContext): LiveInvocation | null {
  // R3 P1: only the slot's owner draft (earliest-anchored) may surface as tracker+draft.
  if (ctx.record || !ctx.draft || !ctx.slot || !ctx.trackerOwnerMatches || !ctx.catId) return null;
  if (!ctx.slotClaimedByThisDraft) return null;
  return {
    catId: ctx.catId,
    invocationId: ctx.invocationId,
    startedAt: ctx.slot.startedAt,
    source: 'tracker+draft',
    degraded: true,
    reason: 'tracker_active_missing_record',
  };
}

function tryRecordFreshDraft(ctx: ClassifyContext): LiveInvocation | null {
  if (!ctx.record || !ctx.draft) return null;
  if (ctx.now - ctx.draft.updatedAt > ctx.freshDraftWindowMs) return null;
  return {
    catId: ctx.catId,
    invocationId: ctx.invocationId,
    startedAt: ctx.draft.createdAt ?? ctx.draft.updatedAt,
    source: 'record+draft',
    degraded: true,
    reason: 'record_running_with_fresh_draft',
  };
}

function tryRecordGraceOrZombie(ctx: ClassifyContext): Classification | null {
  if (!ctx.record) return null;
  const recordAge = ctx.now - ctx.record.updatedAt;
  if (recordAge <= ctx.zombieGraceMs) {
    return {
      kind: 'live',
      live: {
        catId: ctx.catId,
        invocationId: ctx.invocationId,
        startedAt: ctx.record.updatedAt,
        source: 'record-only',
        degraded: true,
        reason: 'liveness_pending',
      },
    };
  }
  return {
    kind: 'zombie',
    zombie: {
      invocationId: ctx.invocationId,
      catId: ctx.catId,
      recordStatus: 'running',
      recordUpdatedAt: ctx.record.updatedAt,
      reason: 'no_tracker_no_fresh_draft_age_exceeded',
    },
  };
}

function classifyCandidate(ctx: ClassifyContext): Classification {
  const recordTracker = tryRecordTracker(ctx);
  if (recordTracker) return { kind: 'live', live: recordTracker };

  const trackerDraft = tryTrackerDraft(ctx);
  if (trackerDraft) return { kind: 'live', live: trackerDraft };

  const recordDraft = tryRecordFreshDraft(ctx);
  if (recordDraft) return { kind: 'live', live: recordDraft };

  const recordGrace = tryRecordGraceOrZombie(ctx);
  if (recordGrace) return recordGrace;

  return { kind: 'drop' };
}

function buildDegradedEvent(
  threadId: string,
  userId: string,
  ctx: ClassifyContext,
  live: LiveInvocation,
): LivenessEvent {
  const isPending = live.reason === 'liveness_pending';
  return {
    kind: isPending ? 'liveness_pending' : 'liveness_degraded',
    threadId,
    userId,
    invocationId: ctx.invocationId,
    catId: live.catId,
    source: live.source,
    reason: live.reason,
    recordStatus: ctx.record ? 'running' : 'absent',
    recordUpdatedAt: ctx.record?.updatedAt ?? null,
    trackerSlotPresent: !!ctx.slot,
    draftFresh: ctx.draft ? ctx.now - ctx.draft.updatedAt <= ctx.freshDraftWindowMs : null,
    draftAge: ctx.draft ? ctx.now - ctx.draft.updatedAt : null,
  };
}

function buildZombieEvent(threadId: string, userId: string, ctx: ClassifyContext, zombie: ZombieRecord): LivenessEvent {
  return {
    kind: 'record_zombie_detected',
    threadId,
    userId,
    invocationId: ctx.invocationId,
    catId: zombie.catId,
    source: null,
    reason: zombie.reason,
    recordStatus: 'running',
    recordUpdatedAt: zombie.recordUpdatedAt,
    trackerSlotPresent: !!ctx.slot,
    draftFresh: false,
    draftAge: ctx.draft ? ctx.now - ctx.draft.updatedAt : null,
  };
}

/** AC-B11/B12: emit a structured event for `degraded` live + zombie outcomes.
 *  Sink failure is swallowed — diagnostic should never break the read path. */
function emitLivenessEvent(
  onLog: ((event: LivenessEvent) => void) | undefined,
  threadId: string,
  userId: string,
  ctx: ClassifyContext,
  result: Classification,
): void {
  if (!onLog) return;
  let event: LivenessEvent | null = null;
  if (result.kind === 'live' && result.live.degraded) {
    event = buildDegradedEvent(threadId, userId, ctx, result.live);
  } else if (result.kind === 'zombie') {
    event = buildZombieEvent(threadId, userId, ctx, result.zombie);
  }
  if (!event) return;
  try {
    onLog(event);
  } catch {
    // swallow — sink errors must not interrupt read path
  }
}

interface IndexBundle {
  recordById: Map<string, InvocationRecord>;
  draftById: Map<string, DraftRecord>;
  slotByCatId: Map<string, ActiveSlotInfo>;
  runningRecordsByCat: Map<string, InvocationRecord[]>;
  /** R2 P1 fix: per-cat, the earliest-anchored draft that strongly claims that cat's tracker slot.
   *  A weak record-tracker association must NOT fire if the slot is already claimed by another
   *  invocation's draft (cat slot reuse / coexistence with record-missing recovery). */
  slotClaimedByDraft: Map<string, DraftRecord>;
}

function buildRunningRecordsByCat(
  records: InvocationRecord[],
  threadId: string,
  userId: string,
): Map<string, InvocationRecord[]> {
  const out = new Map<string, InvocationRecord[]>();
  for (const r of records) {
    if (r.status !== 'running' || r.threadId !== threadId || r.userId !== userId) continue;
    const cat = r.targetCats[0] as string | undefined;
    if (!cat) continue;
    let bucket = out.get(cat);
    if (!bucket) {
      bucket = [];
      out.set(cat, bucket);
    }
    bucket.push(r);
  }
  return out;
}

/** R2 P1 + cloud R5 P1: per-cat earliest-anchored draft that strongly claims that cat's tracker slot.
 *  Stale drafts (updatedAt past freshDraftWindowMs) are excluded — they shouldn't grant ownership
 *  that disables a still-live record's weak path. */
function buildSlotClaimedByDraft(
  drafts: DraftRecord[],
  slotByCatId: Map<string, ActiveSlotInfo>,
  threadId: string,
  userId: string,
  now: number,
  freshDraftWindowMs: number,
): Map<string, DraftRecord> {
  // Pre-filter: only fresh in-scope drafts can claim slot ownership (cloud R5 P1).
  const eligible = drafts.filter(
    (d) => d.threadId === threadId && d.userId === userId && now - d.updatedAt <= freshDraftWindowMs,
  );
  const out = new Map<string, DraftRecord>();
  for (const draft of eligible) {
    const slot = slotByCatId.get(draft.catId);
    if (!slot) continue;
    const anchorTs = draft.createdAt ?? draft.updatedAt;
    if (slot.startedAt > anchorTs) continue;
    const incumbent = out.get(draft.catId);
    const incumbentAnchor = incumbent ? (incumbent.createdAt ?? incumbent.updatedAt) : Number.POSITIVE_INFINITY;
    if (anchorTs < incumbentAnchor) out.set(draft.catId, draft);
  }
  return out;
}

function buildIndexes(
  records: InvocationRecord[],
  drafts: DraftRecord[],
  slots: ActiveSlotInfo[],
  threadId: string,
  userId: string,
  now: number,
  freshDraftWindowMs: number,
): IndexBundle {
  const recordById = new Map<string, InvocationRecord>();
  for (const r of records) recordById.set(r.id, r);
  const draftById = new Map<string, DraftRecord>();
  for (const d of drafts) draftById.set(d.invocationId, d);
  const slotByCatId = new Map<string, ActiveSlotInfo>();
  for (const s of slots) slotByCatId.set(s.catId, s);
  const runningRecordsByCat = buildRunningRecordsByCat(records, threadId, userId);
  const slotClaimedByDraft = buildSlotClaimedByDraft(drafts, slotByCatId, threadId, userId, now, freshDraftWindowMs);
  return { recordById, draftById, slotByCatId, runningRecordsByCat, slotClaimedByDraft };
}

interface BuildContextDeps {
  threadId: string;
  userId: string;
  invocationId: string;
  index: IndexBundle;
  getTrackerUserId: (threadId: string, catId: string) => string | null;
  now: number;
  freshDraftWindowMs: number;
  zombieGraceMs: number;
}

function lookupCandidate(
  deps: BuildContextDeps,
): { record: InvocationRecord | undefined; draft: DraftRecord | undefined } | null {
  const record = deps.index.recordById.get(deps.invocationId);
  // In-scope but not running → drop (treated as not live)
  if (record && (record.status !== 'running' || record.threadId !== deps.threadId || record.userId !== deps.userId)) {
    return null;
  }
  const draft = deps.index.draftById.get(deps.invocationId);
  // Defensive: drafts come scoped from getDrafts(userId, threadId), but guard against caller misuse.
  if (draft && (draft.threadId !== deps.threadId || draft.userId !== deps.userId)) return null;
  return { record, draft };
}

function resolveCatId(record: InvocationRecord | undefined, draft: DraftRecord | undefined): CatId | null {
  const recordCatId = (record?.targetCats[0] as CatId | undefined) ?? null;
  const draftCatId = (draft?.catId as CatId | undefined) ?? null;
  return recordCatId ?? draftCatId;
}

function computeAssociations(args: {
  slot: ActiveSlotInfo | undefined;
  record: InvocationRecord | undefined;
  sameCatRecordCount: number;
  /** R2 P1: true iff cat slot is strongly claimed by a draft other than this candidate's.
   *  Disables weak record association so a fresh slot can't reverse-prove an unrelated record. */
  slotClaimedByOtherDraft: boolean;
}): { slotAssocWithRecordSingle: boolean } {
  const { slot, record, sameCatRecordCount, slotClaimedByOtherDraft } = args;
  const slotAssocWithRecordSingle = !!(
    slot &&
    record &&
    sameCatRecordCount === 1 &&
    record.createdAt <= slot.startedAt &&
    !slotClaimedByOtherDraft
  );
  return { slotAssocWithRecordSingle };
}

function buildClassifyContext(deps: BuildContextDeps): ClassifyContext | null {
  const lookup = lookupCandidate(deps);
  if (!lookup) return null;
  const { record, draft } = lookup;
  const catId = resolveCatId(record, draft);
  const slot = catId ? deps.index.slotByCatId.get(catId) : undefined;
  const trackerOwnerMatches = !!(slot && catId && deps.getTrackerUserId(deps.threadId, catId) === deps.userId);
  const sameCatRecordCount = catId ? (deps.index.runningRecordsByCat.get(catId)?.length ?? 0) : 0;
  const slotClaimingDraft = catId ? deps.index.slotClaimedByDraft.get(catId) : undefined;
  const slotClaimedByThisDraft = !!(slotClaimingDraft && slotClaimingDraft.invocationId === deps.invocationId);
  const slotClaimedByOtherDraft = !!(slotClaimingDraft && slotClaimingDraft.invocationId !== deps.invocationId);
  const { slotAssocWithRecordSingle } = computeAssociations({
    slot,
    record,
    sameCatRecordCount,
    slotClaimedByOtherDraft,
  });

  return {
    invocationId: deps.invocationId,
    record,
    draft,
    slot,
    trackerOwnerMatches,
    slotClaimedByThisDraft,
    slotClaimedByOtherDraft,
    slotAssocWithRecordSingle,
    catId,
    now: deps.now,
    freshDraftWindowMs: deps.freshDraftWindowMs,
    zombieGraceMs: deps.zombieGraceMs,
  };
}

/**
 * F194 Phase Z (KD-22): namespace bridge — for each fresh draft, ask getTurnInvocation what
 * its parent record id is. Returns:
 *   parentToFreshChildren: parent recordStore invocationId → list of fresh-child entries
 *   childIdToParentId: child registry invocationId → parent record id (for skip in legacy loop)
 * When getTurnInvocation dep is absent, returns empty maps → legacy classification path runs as before.
 */
interface NamespaceLinkContext {
  threadId: string;
  userId: string;
  now: number;
  freshDraftWindowMs: number;
  getTurnInvocation: NonNullable<LivenessReadDeps['getTurnInvocation']>;
}

/** Returns null when draft should be skipped (out-of-scope, stale, missing turn info, or cross-user/thread/cat). */
async function resolveDraftToTurn(
  draft: DraftRecord,
  ctx: NamespaceLinkContext,
): Promise<{ parentInvocationId: string; turnCreatedAt: number } | null> {
  if (draft.threadId !== ctx.threadId || draft.userId !== ctx.userId) return null;
  if (ctx.now - draft.updatedAt > ctx.freshDraftWindowMs) return null;
  let info: TurnInvocationInfo | null | undefined;
  try {
    info = await Promise.resolve(ctx.getTurnInvocation(draft.invocationId));
  } catch {
    return null;
  }
  if (!info || !info.parentInvocationId) return null;
  // R2 P1-B: cross-user/thread/cat isolation guard — prevent default/system thread spillover
  if (info.threadId !== ctx.threadId || info.userId !== ctx.userId || info.catId !== draft.catId) return null;
  return { parentInvocationId: info.parentInvocationId, turnCreatedAt: info.createdAt };
}

async function buildNamespaceLink(
  drafts: DraftRecord[],
  threadId: string,
  userId: string,
  now: number,
  freshDraftWindowMs: number,
  getTurnInvocation: LivenessReadDeps['getTurnInvocation'],
): Promise<{
  parentToFreshChildren: Map<string, Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>>;
  childIdToParentId: Map<string, string>;
}> {
  const parentToFreshChildren = new Map<
    string,
    Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>
  >();
  const childIdToParentId = new Map<string, string>();
  if (!getTurnInvocation) return { parentToFreshChildren, childIdToParentId };

  const ctx: NamespaceLinkContext = { threadId, userId, now, freshDraftWindowMs, getTurnInvocation };
  for (const draft of drafts) {
    const link = await resolveDraftToTurn(draft, ctx);
    if (!link) continue;
    childIdToParentId.set(draft.invocationId, link.parentInvocationId);
    let bucket = parentToFreshChildren.get(link.parentInvocationId);
    if (!bucket) {
      bucket = [];
      parentToFreshChildren.set(link.parentInvocationId, bucket);
    }
    bucket.push({ childTurnId: draft.invocationId, draft, turnCreatedAt: link.turnCreatedAt });
  }
  return { parentToFreshChildren, childIdToParentId };
}

type NamespaceCatChild = { catId: string; childTurnId: string; turnCreatedAt: number };

/** Pick the canonical child per cat: registry latest pointer wins; tiebreak fallback = newest createdAt
 *  (NOT earliest — would re-surface stale child after cleanup edge cases — 砚砚 R2 P1-C). */
function selectChildPerCat(
  children: Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>,
  latestTurnByCat: Map<string, string>,
): Map<string, NamespaceCatChild> {
  const byCatId = new Map<string, NamespaceCatChild>();
  for (const child of children) {
    const cat = child.draft.catId;
    if (!cat) continue;
    const candidate: NamespaceCatChild = {
      catId: cat,
      childTurnId: child.childTurnId,
      turnCreatedAt: child.turnCreatedAt,
    };
    const existing = byCatId.get(cat);
    if (!existing) {
      byCatId.set(cat, candidate);
      continue;
    }
    const latestId = latestTurnByCat.get(cat);
    const candidateIsLatest = latestId === child.childTurnId;
    const existingIsLatest = latestId === existing.childTurnId;
    if (candidateIsLatest && !existingIsLatest) byCatId.set(cat, candidate);
    else if (!candidateIsLatest && !existingIsLatest && child.turnCreatedAt > existing.turnCreatedAt)
      byCatId.set(cat, candidate);
  }
  return byCatId;
}

interface NamespaceLiveContext {
  threadId: string;
  userId: string;
  slotByCatId: Map<string, ActiveSlotInfo>;
  getTrackerUserId: LivenessReadDeps['getTrackerUserId'];
}

/** R3 P2-1: tracker presence must be user-scoped. Mirror legacy classifier guard so cross-user slot
 *  on default/system thread doesn't get classified as healthy `parent+child+tracker` for our user. */
function isTrackerSlotOwnedByUser(catId: string, ctx: NamespaceLiveContext): boolean {
  const slot = ctx.slotByCatId.get(catId);
  if (!slot) return false;
  return ctx.getTrackerUserId(ctx.threadId, catId) === ctx.userId;
}

function materializeNamespaceLive(
  byCatId: Map<string, NamespaceCatChild>,
  ctx: NamespaceLiveContext,
): LiveInvocation[] {
  const result: LiveInvocation[] = [];
  for (const [catId, entry] of byCatId) {
    const trackerOwned = isTrackerSlotOwnedByUser(catId, ctx);
    result.push({
      catId: catId as CatId,
      // KD-22: invocationId = child registry id (matches DraftStore key + formal-message stamping
      // for current cat turn). Parent record id is the liveness anchor for cleanup, but the
      // identity surfaced to consumers (orphan-draft filter / queue activeInvocations dedup) is
      // the child turn — that's what drafts and downstream consumers actually reference.
      invocationId: entry.childTurnId,
      startedAt: entry.turnCreatedAt,
      source: trackerOwned ? 'parent+child+tracker' : 'parent+child-draft',
      degraded: !trackerOwned,
      reason: trackerOwned ? 'namespace_chain_active' : 'namespace_chain_degraded',
    });
  }
  return result;
}

function buildNamespaceLive(
  _parent: InvocationRecord,
  children: Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>,
  ctx: NamespaceLiveContext,
  latestTurnByCat: Map<string, string>,
): LiveInvocation[] {
  // One active per cat (parallel chain may have multiple cats under same parent).
  // R2 P1-C dedup → R3 P2-1 user-scoped tracker check.
  const byCatId = selectChildPerCat(children, latestTurnByCat);
  return materializeNamespaceLive(byCatId, ctx);
}

/** Cloud R2 P1: cat slot is "actively reused" iff some OTHER parent currently has a fresh draft for
 *  this cat. Historical latest pointer alone is unreliable — it can persist across legitimate gaps
 *  (between serial multi-cat turns, before current chain produces first draft). Requiring a current
 *  fresh-draft signal from another parent eliminates the false-positive that prematurely flips
 *  in-flight invocations to failed. */
function isCatActivelyClaimedByOtherParent(
  parent: InvocationRecord,
  cat: string,
  parentToFreshChildren: Map<string, Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>>,
): boolean {
  for (const [otherParentId, children] of parentToFreshChildren) {
    if (otherParentId === parent.id) continue;
    for (const c of children) {
      if (c.draft.catId === cat) return true;
    }
  }
  return false;
}

/**
 * F194 Phase Z (KD-22): cat-slot-reuse detection.
 * For a parent record with NO own fresh children, iterate ALL parent.targetCats — if any cat slot
 * is actively claimed by another parent (via fresh draft), this parent's chain is dead → zombie
 * candidate with reason 'cat_slot_reused_no_self_draft'.
 *
 * Cloud R1 P1 (PR #1614): probe ALL targetCats, not just [0] — multi-cat parents whose non-first
 * cat slot was reused were missed.
 *
 * Cloud R2 P1 (PR #1614 commit 02c25a177): require fresh-draft proof, not historical latest pointer.
 * latest pointer persists across legitimate gaps and would prematurely flip in-flight invocations.
 *
 * Read-side does NOT terminalize (砚砚 R1 P1-3); reconcile pathway decides failed vs succeeded.
 * If no current reuse detected here, parent falls through to legacy pass which has age-based grace.
 */
function detectCatSlotReuseZombie(
  parent: InvocationRecord,
  parentToFreshChildren: Map<string, Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>>,
): ZombieRecord | null {
  for (const targetCat of parent.targetCats as readonly string[]) {
    if (!targetCat) continue;
    if (isCatActivelyClaimedByOtherParent(parent, targetCat, parentToFreshChildren)) {
      return {
        invocationId: parent.id,
        catId: targetCat as CatId,
        recordStatus: 'running',
        recordUpdatedAt: parent.updatedAt,
        reason: 'cat_slot_reused_no_self_draft',
      };
    }
  }
  return null;
}

/** F194 Phase Z (KD-22, 砚砚 R2 P2): emit diagnostic event for namespace-classified live entries.
 *  parent+child-draft (degraded) and parent+child+tracker (info-level) both useful for runtime
 *  monitoring. Sink throws are swallowed (mirrors emitLivenessEvent semantics).
 *
 *  Cloud R5 P2 (PR #1614 commit e2b967d2a): trackerSlotPresent must reflect actual physical
 *  presence, not the trackerOwned classification. degraded path also fires when tracker slot
 *  exists but is owned by another user (R3 P2-1 cross-user guard) — emitting `false` would let
 *  monitoring/alerting misclassify ownership-collision as tracker-loss. */
function emitNamespaceLiveEvent(
  onLog: ((event: LivenessEvent) => void) | undefined,
  threadId: string,
  userId: string,
  parentRecord: InvocationRecord,
  live: LiveInvocation,
  draft: DraftRecord | undefined,
  now: number,
  freshDraftWindowMs: number,
  trackerSlotPresent: boolean,
): void {
  if (!onLog) return;
  // Only emit for degraded entries (parent+child-draft) — parent+child+tracker is healthy + noisy
  if (!live.degraded) return;
  try {
    onLog({
      kind: 'liveness_degraded',
      threadId,
      userId,
      invocationId: live.invocationId,
      catId: live.catId,
      source: live.source,
      reason: live.reason,
      recordStatus: 'running',
      recordUpdatedAt: parentRecord.updatedAt,
      trackerSlotPresent,
      draftFresh: draft ? now - draft.updatedAt <= freshDraftWindowMs : null,
      draftAge: draft ? now - draft.updatedAt : null,
    });
  } catch {
    // swallow sink errors
  }
}

/** Cloud R4 P2 (PR #1614 commit 747e6c770): trackerSlotPresent must reflect actual tracker state.
 *  detectCatSlotReuseZombie used to rely on tracker, but now classifies via fresh drafts only —
 *  hardcoded `true` would skew F194 monitoring/alerting that uses this field to distinguish tracker
 *  loss from real slot occupancy. Caller passes the actual presence from slotByCatId.has(catId). */
function emitNamespaceZombieEvent(
  onLog: ((event: LivenessEvent) => void) | undefined,
  threadId: string,
  userId: string,
  zombie: ZombieRecord,
  trackerSlotPresent: boolean,
): void {
  if (!onLog) return;
  try {
    onLog({
      kind: 'record_zombie_detected',
      threadId,
      userId,
      invocationId: zombie.invocationId,
      catId: zombie.catId,
      source: null,
      reason: zombie.reason,
      recordStatus: 'running',
      recordUpdatedAt: zombie.recordUpdatedAt,
      trackerSlotPresent,
      draftFresh: false,
      draftAge: null,
    });
  } catch {
    // swallow sink errors
  }
}

async function resolveLatestTurnByCat(
  parentToFreshChildren: Map<string, Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>>,
  threadId: string,
  getLatestTurnInvocationId: LivenessReadDeps['getLatestTurnInvocationId'],
): Promise<Map<string, string>> {
  const latestTurnByCat = new Map<string, string>();
  if (!getLatestTurnInvocationId) return latestTurnByCat;
  const catsToResolve = new Set<string>();
  for (const children of parentToFreshChildren.values()) {
    for (const child of children) {
      const cat = child.draft.catId;
      if (cat) catsToResolve.add(cat);
    }
  }
  for (const cat of catsToResolve) {
    try {
      const latestId = await Promise.resolve(getLatestTurnInvocationId(threadId, cat));
      if (latestId) latestTurnByCat.set(cat, latestId);
    } catch {
      // dep failure must not break read; leave map entry absent → falls back to newest createdAt
    }
  }
  return latestTurnByCat;
}

interface NamespacePassDeps {
  threadId: string;
  userId: string;
  now: number;
  freshDraftWindowMs: number;
  getLatestTurnInvocationId: LivenessReadDeps['getLatestTurnInvocationId'];
  getTurnInvocation: LivenessReadDeps['getTurnInvocation'];
  onLog?: LivenessReadDeps['onLog'];
  parentToFreshChildren: Map<string, Array<{ childTurnId: string; draft: DraftRecord; turnCreatedAt: number }>>;
  latestTurnByCat: Map<string, string>;
  namespaceLiveCtx: NamespaceLiveContext;
}

async function processRecordInNamespacePass(
  record: InvocationRecord,
  passDeps: NamespacePassDeps,
): Promise<{
  candidates: Array<{ live: LiveInvocation; draft: DraftRecord | undefined; parent: InvocationRecord }>;
  zombie: ZombieRecord | null;
  handled: boolean;
}> {
  const children = passDeps.parentToFreshChildren.get(record.id);
  if (children && children.length > 0) {
    const liveEntries = buildNamespaceLive(record, children, passDeps.namespaceLiveCtx, passDeps.latestTurnByCat);
    if (liveEntries.length > 0) {
      const candidates = liveEntries.map((live) => ({
        live,
        draft: children.find((c) => c.childTurnId === live.invocationId)?.draft,
        parent: record,
      }));
      // Diagnostic emit happens AFTER cross-parent dedup so we don't log losers as live.
      return { candidates, zombie: null, handled: true };
    }
    // children exist but selectChildPerCat suppressed all (within-parent edge case) — fall through to
    // zombie detection so we don't leave the parent dangling.
  }
  const zombie = detectCatSlotReuseZombie(record, passDeps.parentToFreshChildren);
  if (zombie) {
    const trackerSlotPresent = passDeps.namespaceLiveCtx.slotByCatId.has(zombie.catId as string);
    emitNamespaceZombieEvent(passDeps.onLog, passDeps.threadId, passDeps.userId, zombie, trackerSlotPresent);
    return { candidates: [], zombie, handled: true };
  }
  return { candidates: [], zombie: null, handled: false };
}

type NamespaceCandidate = { live: LiveInvocation; draft: DraftRecord | undefined; parent: InvocationRecord };

function groupCandidatesByCat(candidates: NamespaceCandidate[]): Map<string, NamespaceCandidate[]> {
  const byCat = new Map<string, NamespaceCandidate[]>();
  for (const entry of candidates) {
    const cat = entry.live.catId as string;
    let bucket = byCat.get(cat);
    if (!bucket) {
      bucket = [];
      byCat.set(cat, bucket);
    }
    bucket.push(entry);
  }
  return byCat;
}

function pickWinnerIdx(list: NamespaceCandidate[], latestId: string | undefined): number {
  if (latestId) {
    const idx = list.findIndex((e) => e.live.invocationId === latestId);
    if (idx >= 0) return idx;
  }
  // Fallback: newest startedAt wins (mirrors selectChildPerCat in-parent fallback).
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].live.startedAt > list[best].live.startedAt) best = i;
  }
  return best;
}

function emitWinnerAsLive(winner: NamespaceCandidate, passDeps: NamespacePassDeps): void {
  // Cloud R5 P2: actual tracker physical presence (not the trackerOwned classification)
  const trackerSlotPresent = passDeps.namespaceLiveCtx.slotByCatId.has(winner.live.catId as string);
  emitNamespaceLiveEvent(
    passDeps.onLog,
    passDeps.threadId,
    passDeps.userId,
    winner.parent,
    winner.live,
    winner.draft,
    passDeps.now,
    passDeps.freshDraftWindowMs,
    trackerSlotPresent,
  );
}

function buildLoserZombie(loser: NamespaceCandidate, cat: string): ZombieRecord {
  return {
    invocationId: loser.parent.id,
    catId: cat as CatId,
    recordStatus: 'running',
    recordUpdatedAt: loser.parent.updatedAt,
    reason: 'cat_slot_reused_no_self_draft',
  };
}

function selectWinnersAndLosers(
  byCat: Map<string, NamespaceCandidate[]>,
  latestTurnByCat: Map<string, string>,
): { winners: NamespaceCandidate[]; losers: NamespaceCandidate[] } {
  const winners: NamespaceCandidate[] = [];
  const losers: NamespaceCandidate[] = [];
  for (const [cat, list] of byCat) {
    const winnerIdx = list.length === 1 ? 0 : pickWinnerIdx(list, latestTurnByCat.get(cat));
    winners.push(list[winnerIdx]);
    for (let i = 0; i < list.length; i++) {
      if (i !== winnerIdx) losers.push(list[i]);
    }
  }
  return { winners, losers };
}

function aggregateParentZombies(
  losers: NamespaceCandidate[],
  winningParentIds: Set<string>,
  passDeps: NamespacePassDeps,
): ZombieRecord[] {
  const zombies: ZombieRecord[] = [];
  const seenParentIds = new Set<string>();
  for (const loser of losers) {
    // R5 P1: skip if parent still has another winning child cat — slot reuse is partial, parent still live.
    if (winningParentIds.has(loser.parent.id)) continue;
    // R5 P1: dedup zombie per-parent — multi-cat parent that loses all cats only emits 1 zombie.
    if (seenParentIds.has(loser.parent.id)) continue;
    seenParentIds.add(loser.parent.id);
    const zombie = buildLoserZombie(loser, loser.live.catId as string);
    zombies.push(zombie);
    const trackerSlotPresent = passDeps.namespaceLiveCtx.slotByCatId.has(zombie.catId as string);
    emitNamespaceZombieEvent(passDeps.onLog, passDeps.threadId, passDeps.userId, zombie, trackerSlotPresent);
  }
  return zombies;
}

/** R4 P1 (砚砚 spec line 207): cross-parent same-cat dedup using registry latest pointer.
 *  Each parent's namespace pass produces independent live candidates per cat. When two parents
 *  both have a fresh child for the same cat, latest pointer (registry-authoritative) wins.
 *
 *  R5 P1 (砚砚): the loser is a CAT slot suppression, not a parent death. Only when a parent has
 *  NO winning child across all its cats does it become a true cat_slot_reused_no_self_draft zombie.
 *  Multi-cat parent losing only one cat (other cats still winning) stays live; its losing cat slot
 *  silently moves to the new parent (the losing draft will TTL-expire). Parent zombie also
 *  deduplicates per-parent — losing N cats emits 1 zombie, not N. */
function dedupCrossParentByCatLatest(
  candidates: NamespaceCandidate[],
  latestTurnByCat: Map<string, string>,
  passDeps: NamespacePassDeps,
): { active: LiveInvocation[]; suppressedZombies: ZombieRecord[] } {
  const byCat = groupCandidatesByCat(candidates);
  const { winners, losers } = selectWinnersAndLosers(byCat, latestTurnByCat);
  const active: LiveInvocation[] = [];
  const winningParentIds = new Set<string>();
  for (const winner of winners) {
    active.push(winner.live);
    winningParentIds.add(winner.parent.id);
    emitWinnerAsLive(winner, passDeps);
  }
  const suppressedZombies = aggregateParentZombies(losers, winningParentIds, passDeps);
  return { active, suppressedZombies };
}

interface LegacyPassDeps {
  threadId: string;
  userId: string;
  now: number;
  freshDraftWindowMs: number;
  zombieGraceMs: number;
  index: IndexBundle;
  getTrackerUserId: LivenessReadDeps['getTrackerUserId'];
  onLog?: LivenessReadDeps['onLog'];
}

function runLegacyPass(
  candidateIds: Set<string>,
  deps: LegacyPassDeps,
): { active: LiveInvocation[]; zombies: ZombieRecord[] } {
  const active: LiveInvocation[] = [];
  const zombies: ZombieRecord[] = [];
  for (const invocationId of candidateIds) {
    const ctx = buildClassifyContext({
      threadId: deps.threadId,
      userId: deps.userId,
      invocationId,
      index: deps.index,
      getTrackerUserId: deps.getTrackerUserId,
      now: deps.now,
      freshDraftWindowMs: deps.freshDraftWindowMs,
      zombieGraceMs: deps.zombieGraceMs,
    });
    if (!ctx) continue;
    const result = classifyCandidate(ctx);
    emitLivenessEvent(deps.onLog, deps.threadId, deps.userId, ctx, result);
    if (result.kind === 'live') active.push(result.live);
    else if (result.kind === 'zombie') zombies.push(result.zombie);
  }
  return { active, zombies };
}

function collectLegacyCandidates(
  records: InvocationRecord[],
  drafts: DraftRecord[],
  handledRecordIds: Set<string>,
  childIdToParentId: Map<string, string>,
): Set<string> {
  const candidateIds = new Set<string>();
  for (const r of records) if (!handledRecordIds.has(r.id)) candidateIds.add(r.id);
  for (const d of drafts) {
    const parentId = childIdToParentId.get(d.invocationId);
    if (parentId && handledRecordIds.has(parentId)) continue;
    candidateIds.add(d.invocationId);
  }
  return candidateIds;
}

export async function getThreadLiveInvocations(
  threadId: string,
  userId: string,
  deps: LivenessReadDeps,
  opts: LivenessReadOptions = {},
): Promise<LivenessReadResult> {
  const now = opts.now ?? Date.now();
  const freshDraftWindowMs = opts.freshDraftWindowMs ?? DEFAULT_FRESH_DRAFT_WINDOW_MS;
  const zombieGraceMs = opts.zombieGraceMs ?? DEFAULT_ZOMBIE_GRACE_MS;

  const [records, drafts] = await Promise.all([
    Promise.resolve(deps.listRunningRecords(threadId, userId)),
    Promise.resolve(deps.getDrafts(userId, threadId)),
  ]);
  const slots = deps.getActiveSlots(threadId);
  const index = buildIndexes(records, drafts, slots, threadId, userId, now, freshDraftWindowMs);

  const { parentToFreshChildren, childIdToParentId } = await buildNamespaceLink(
    drafts,
    threadId,
    userId,
    now,
    freshDraftWindowMs,
    deps.getTurnInvocation,
  );
  const latestTurnByCat = await resolveLatestTurnByCat(parentToFreshChildren, threadId, deps.getLatestTurnInvocationId);

  const passDeps: NamespacePassDeps = {
    threadId,
    userId,
    now,
    freshDraftWindowMs,
    getLatestTurnInvocationId: deps.getLatestTurnInvocationId,
    getTurnInvocation: deps.getTurnInvocation,
    onLog: deps.onLog,
    parentToFreshChildren,
    latestTurnByCat,
    namespaceLiveCtx: {
      threadId,
      userId,
      slotByCatId: index.slotByCatId,
      getTrackerUserId: deps.getTrackerUserId,
    },
  };

  const active: LiveInvocation[] = [];
  const zombies: ZombieRecord[] = [];
  const handledRecordIds = new Set<string>();
  const namespaceCandidates: NamespaceCandidate[] = [];

  for (const record of records) {
    if (record.status !== 'running' || record.threadId !== threadId || record.userId !== userId) continue;
    const outcome = await processRecordInNamespacePass(record, passDeps);
    if (!outcome.handled) continue;
    namespaceCandidates.push(...outcome.candidates);
    if (outcome.zombie) zombies.push(outcome.zombie);
    handledRecordIds.add(record.id);
  }

  // R4 P1 (砚砚): cross-parent same-cat dedup. Until now each parent's namespace pass produced
  // candidates independently; here registry latest pointer wins across parents (loser → zombie).
  // Diagnostic emit happens here, not in processRecordInNamespacePass, so losers are never logged as live.
  const deduped = dedupCrossParentByCatLatest(namespaceCandidates, latestTurnByCat, passDeps);
  active.push(...deduped.active);
  zombies.push(...deduped.suppressedZombies);

  const legacyCandidates = collectLegacyCandidates(records, drafts, handledRecordIds, childIdToParentId);
  const legacyResult = runLegacyPass(legacyCandidates, {
    threadId,
    userId,
    now,
    freshDraftWindowMs,
    zombieGraceMs,
    index,
    getTrackerUserId: deps.getTrackerUserId,
    onLog: deps.onLog,
  });
  active.push(...legacyResult.active);
  zombies.push(...legacyResult.zombies);

  return { active, zombies };
}
