/**
 * F194 → F117 KD-23: Invocation liveness read model.
 *
 * Answers "which members are processing for (threadId, userId)?" without reading any timestamp.
 * A member is processing when its InvocationRecord is running and someone verifiably runs its turn:
 *
 * - this process's InvocationTracker holds the member's slot for the record's execution; or
 * - the CLI owner snapshot lists a live owner (its supervisor process still exists) for the
 *   record's execution and the member.
 *
 * A running record or TurnExecution child alone proves nothing: when the owner snapshot is
 * incomplete the startup settlement keeps the previous process's running children, and a turn
 * whose owner died stays running until something settles it. With a complete snapshot that lists no
 * owner, such a member is not processing, and the active-execution read-repair ends the record.
 *
 * Without a complete snapshot nobody can tell whether an owner outside this process lives, so the
 * evidence that remains is listed, degraded: the user still sees it and can stop it (F117 KD-10:
 * running and not running are the only states; Stop settles an execution it cannot verify, AC-E7).
 * - A running child stands in for its owner: an owner that outlives this process started its turn,
 *   and so its child, before this process started.
 * - When the caller took a snapshot and it is incomplete, a running record that nothing else lists is
 *   listed through its members, named by the record: a control surface must keep an execution it
 *   cannot verify stoppable. A caller that takes no snapshot (sidebar presence) asks only whether
 *   anyone runs the thread, and a record with no slot, owner or child answers no.
 *
 * QueueProcessor turns a record running only after the tracker takes its slots, so a turn that only
 * holds a processing reservation is still queued and is not listed here. A slot whose execution has
 * no running record yet (the few awaits between the tracker taking the slot and the record turning
 * running), or whose execution the tracker cannot name, is this process's and is listed, degraded.
 *
 * The response R is checked by the caller (live-invocation-projection): a member whose R is already
 * terminal is not processing. Nothing here classifies zombies: the F118 owner reaper, the KD-21
 * startup settlement and the active-execution read-repair end turns, and none of them reads drafts.
 */

import type { CatId, TurnExecutionRecord } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { ActiveSlotInfo } from './InvocationTracker.js';

export type LivenessSource =
  /** The record is running and this process's tracker holds the member's slot for it. */
  | 'record+tracker'
  /** The record is running and the owner snapshot lists a live CLI owner for the member. */
  | 'record+owner'
  /** The record is running, the member has a running child, and no complete snapshot can tell whether its owner lives. */
  | 'parent+child-execution'
  /** The record is running, nothing else lists it, and the caller's snapshot is incomplete. */
  | 'record-only'
  /** The tracker holds the slot and its record is not running yet, or the tracker cannot name its execution. */
  | 'tracker-only';

export type LivenessReason =
  | 'tracker_present'
  | 'cli_owner_alive'
  | 'child_running_owner_unverified'
  | 'record_running_owner_unverified'
  | 'tracker_active_missing_record';

export interface LiveInvocation {
  catId: CatId;
  /**
   * Parent execution owner used for lifecycle/control-plane correlation (the InvocationRecord id).
   * Absent only for a slot whose execution the tracker cannot name; routes show it unresolved.
   */
  executionId?: string;
  /** The member's child turn when known (tracker activeRun, owner or durable child), else the execution. */
  invocationId?: string;
  /**
   * When the member's turn started: the tracker's bound activeRun, else when the tracker took the slot;
   * for an owner or a durable child, when it started. A multi-cat chain takes each slot at its start, so
   * the bound turn is what keeps a later member's timer from counting the whole chain (F194 Phase Z4).
   */
  startedAt: number;
  /** The exact response R the tracker's activeRun names, when the member already has one. */
  responseMessageId?: string;
  source: LivenessSource;
  /** Evidence that does not verify an owner: a slot without its running record, or a running record or child the snapshot cannot vouch for. */
  degraded: boolean;
  reason: LivenessReason;
}

export interface LivenessReadResult {
  active: LiveInvocation[];
}

/** A live CLI owner from the owner snapshot (cli-process-ownership's LiveCliExecutionOwner). */
export interface LiveOwnerRef {
  readonly executionId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly userId: string;
  readonly startedAt: number;
}

/** The CLI owner snapshot a caller took; `complete: false` means it could not be read in full. */
export interface OwnerSnapshot {
  readonly complete: boolean;
  readonly owners: readonly LiveOwnerRef[];
}

export interface LivenessReadDeps {
  /** Enumerate running InvocationRecords for (threadId, userId). */
  listRunningRecords: (threadId: string, userId: string) => Promise<InvocationRecord[]> | InvocationRecord[];
  /** InvocationTracker.getActiveSlots(threadId) */
  getActiveSlots: (threadId: string) => ActiveSlotInfo[];
  /** InvocationTracker.getUserId(threadId, catId) — guards against cross-user tracker collisions */
  getTrackerUserId: (threadId: string, catId: string) => string | null;
  /** InvocationTracker.getExecutionId(threadId, catId) — the execution that holds the slot */
  getTrackerExecutionId: (threadId: string, catId: string) => string | undefined;
  /** Durable child executions of a parent. When the configured store fails, the error propagates to
   *  the caller's fail-open path: "unknown" must not read as "no running child". */
  listTurnExecutionsByParent?: (parentInvocationId: string) => Promise<TurnExecutionRecord[]> | TurnExecutionRecord[];
  /**
   * The CLI owner snapshot the caller already took. A listed owner proves its member processing.
   * When the snapshot is complete, a running child without a slot or an owner proves nothing; when
   * it is absent or incomplete, a running child stands in for the owner it cannot verify, and when
   * it is incomplete, so does a running record that nothing else lists.
   */
  ownerSnapshot?: OwnerSnapshot;
}

type RunningChildExecution = TurnExecutionRecord & { status: 'running' };

function isScopedRunningChild(
  child: TurnExecutionRecord,
  parent: InvocationRecord,
  threadId: string,
  userId: string,
): child is RunningChildExecution {
  return (
    child.status === 'running' &&
    child.parentInvocationId === parent.id &&
    child.threadId === threadId &&
    child.userId === userId &&
    typeof child.invocationId === 'string' &&
    child.invocationId.length > 0 &&
    typeof child.catId === 'string' &&
    child.catId.length > 0 &&
    Number.isFinite(child.startedAt) &&
    child.startedAt >= 0
  );
}

interface HeldSlot {
  readonly slot: ActiveSlotInfo;
  /** Undefined when the tracker cannot name the slot's execution. */
  readonly executionId: string | undefined;
}

/**
 * A slot this process holds. Its turn is the run the tracker has bound; until a run is bound (the
 * child admission window) the member's newest running durable child names the turn, so the identity
 * does not tear while the run is being bound. Neither the child nor the run is the evidence: the slot is.
 */
function liveFromSlot(
  held: HeldSlot,
  source: 'record+tracker' | 'tracker-only',
  child?: RunningChildExecution,
): LiveInvocation {
  const { slot, executionId } = held;
  return {
    catId: slot.catId as CatId,
    executionId,
    invocationId: slot.activeRun?.invocationId ?? child?.invocationId ?? executionId,
    startedAt: slot.activeRun?.startedAt ?? child?.startedAt ?? slot.startedAt,
    ...(slot.activeRun ? { responseMessageId: slot.activeRun.responseMessageId } : {}),
    source,
    degraded: source === 'tracker-only',
    reason: source === 'record+tracker' ? 'tracker_present' : 'tracker_active_missing_record',
  };
}

/** The newest live owner per member of this execution that no tracker slot already proves. */
function liveFromOwners(
  record: InvocationRecord,
  provenCats: ReadonlySet<string>,
  threadId: string,
  userId: string,
  owners: readonly LiveOwnerRef[],
): LiveInvocation[] {
  const newestByCat = new Map<string, LiveOwnerRef>();
  for (const owner of owners) {
    if (owner.executionId !== record.id || owner.threadId !== threadId || owner.userId !== userId) continue;
    if (!owner.catId || provenCats.has(owner.catId)) continue;
    const existing = newestByCat.get(owner.catId);
    if (!existing || owner.startedAt > existing.startedAt) newestByCat.set(owner.catId, owner);
  }
  return Array.from(newestByCat.values(), (owner) => ({
    catId: owner.catId as CatId,
    executionId: record.id,
    invocationId: owner.invocationId,
    startedAt: owner.startedAt,
    source: 'record+owner' as const,
    degraded: false,
    reason: 'cli_owner_alive' as const,
  }));
}

/** The newest running durable child of this record per member. */
async function newestRunningChildren(
  record: InvocationRecord,
  threadId: string,
  userId: string,
  listTurnExecutionsByParent: NonNullable<LivenessReadDeps['listTurnExecutionsByParent']>,
): Promise<Map<string, RunningChildExecution>> {
  const newestByCat = new Map<string, RunningChildExecution>();
  for (const child of await Promise.resolve(listTurnExecutionsByParent(record.id))) {
    if (!isScopedRunningChild(child, record, threadId, userId)) continue;
    const existing = newestByCat.get(child.catId);
    if (!existing || child.startedAt > existing.startedAt) newestByCat.set(child.catId, child);
  }
  return newestByCat;
}

/** A running child standing in for an owner no complete snapshot can verify. */
function liveFromUnverifiedChild(record: InvocationRecord, child: RunningChildExecution): LiveInvocation {
  return {
    catId: child.catId as CatId,
    executionId: record.id,
    invocationId: child.invocationId,
    startedAt: child.startedAt,
    source: 'parent+child-execution',
    degraded: true,
    reason: 'child_running_owner_unverified',
  };
}

/** A member of a running record that nothing else lists, while the caller's snapshot is incomplete. */
function liveFromUnverifiedRecord(record: InvocationRecord, catId: string): LiveInvocation {
  return {
    catId: catId as CatId,
    executionId: record.id,
    invocationId: record.id,
    startedAt: record.updatedAt,
    source: 'record-only',
    degraded: true,
    reason: 'record_running_owner_unverified',
  };
}

/** What the caller knows about who runs this thread's turns, shared by every running record. */
interface OwnerEvidence {
  readonly threadId: string;
  readonly userId: string;
  readonly heldSlots: readonly HeldSlot[];
  readonly owners: readonly LiveOwnerRef[];
  /** The caller has no complete snapshot. */
  readonly ownerUnverifiable: boolean;
  /** The caller took a snapshot and it is incomplete. */
  readonly snapshotIncomplete: boolean;
}

/** The members of one running record that count as processing. */
function liveForRecord(
  record: InvocationRecord,
  children: ReadonlyMap<string, RunningChildExecution>,
  evidence: OwnerEvidence,
): LiveInvocation[] {
  const held = evidence.heldSlots.filter((entry) => entry.executionId === record.id);
  const listed = held.map((entry) => liveFromSlot(entry, 'record+tracker', children.get(entry.slot.catId)));
  const proven = new Set<string>(held.map((entry) => entry.slot.catId));
  const byOwner = liveFromOwners(record, proven, evidence.threadId, evidence.userId, evidence.owners);
  listed.push(...byOwner);
  if (!evidence.ownerUnverifiable) return listed;

  for (const live of byOwner) proven.add(live.catId);
  for (const [catId, child] of children) {
    if (!proven.has(catId)) listed.push(liveFromUnverifiedChild(record, child));
  }
  if (listed.length === 0 && evidence.snapshotIncomplete) {
    for (const catId of new Set(record.targetCats as string[])) listed.push(liveFromUnverifiedRecord(record, catId));
  }
  return listed;
}

export async function getThreadLiveInvocations(
  threadId: string,
  userId: string,
  deps: LivenessReadDeps,
): Promise<LivenessReadResult> {
  const records = (await Promise.resolve(deps.listRunningRecords(threadId, userId))).filter(
    (record) => record.status === 'running' && record.threadId === threadId && record.userId === userId,
  );
  const heldSlots: HeldSlot[] = deps
    .getActiveSlots(threadId)
    .flatMap((slot) =>
      deps.getTrackerUserId(threadId, slot.catId) === userId
        ? [{ slot, executionId: deps.getTrackerExecutionId(threadId, slot.catId) }]
        : [],
    );
  const evidence: OwnerEvidence = {
    threadId,
    userId,
    heldSlots,
    owners: deps.ownerSnapshot?.owners ?? [],
    ownerUnverifiable: deps.ownerSnapshot?.complete !== true,
    snapshotIncomplete: deps.ownerSnapshot?.complete === false,
  };

  const active: LiveInvocation[] = [];
  for (const record of records) {
    const children = deps.listTurnExecutionsByParent
      ? await newestRunningChildren(record, threadId, userId, deps.listTurnExecutionsByParent)
      : new Map<string, RunningChildExecution>();
    active.push(...liveForRecord(record, children, evidence));
  }
  const runningRecordIds = new Set(records.map((record) => record.id));
  for (const entry of heldSlots) {
    if (entry.executionId === undefined || !runningRecordIds.has(entry.executionId)) {
      active.push(liveFromSlot(entry, 'tracker-only'));
    }
  }
  return { active };
}
