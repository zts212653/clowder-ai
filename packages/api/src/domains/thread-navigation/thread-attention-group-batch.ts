import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ThreadAttentionGroupMembershipV1 } from '../cats/services/stores/ports/ThreadStore.js';

type Membership = ThreadAttentionGroupMembershipV1 | null;
export interface GroupSnapshot {
  id: string;
  threadIds: string[];
}
export interface GroupUndoEntry {
  threadId: string;
  before: Membership;
  after: Membership;
}
export interface GroupUndoReceipt {
  entries: GroupUndoEntry[];
  proof: string;
}

/** Current-UI receipts are scoped to an owner and this API instance; no receipt store. */
export function createGroupUndoProof() {
  const key = randomBytes(32);
  const membership = (value: Membership) => (value ? [value.v, value.groupId, value.order] : null);
  const digest = (userId: string, entries: readonly GroupUndoEntry[]) =>
    createHmac('sha256', key)
      .update(
        JSON.stringify([
          'thread-attention-undo:v1',
          userId,
          entries.map((entry) => [entry.threadId, membership(entry.before), membership(entry.after)]),
        ]),
      )
      .digest();
  return {
    issue(userId: string, entries: GroupUndoEntry[]): GroupUndoReceipt {
      return { entries, proof: digest(userId, entries).toString('hex') };
    },
    verify(userId: string, entries: readonly GroupUndoEntry[], proof: string | undefined): boolean {
      if (!proof || !/^[a-f0-9]{64}$/.test(proof)) return false;
      return timingSafeEqual(digest(userId, entries), Buffer.from(proof, 'hex'));
    },
  };
}
export type BatchGroupCommand =
  | { action: 'organize'; threadIds: string[]; expectedGroups: GroupSnapshot[]; name?: string; groupId?: string }
  | { action: 'undo'; entries: GroupUndoEntry[] };

export class ThreadAttentionGroupConflict extends Error {
  constructor(message = '对话组已发生变化，请重新查看后再整理') {
    super(message);
  }
}

function equalMembership(a: Membership | undefined, b: Membership | undefined): boolean {
  return a?.groupId === b?.groupId && a?.order === b?.order && a?.v === b?.v;
}

export function assertOrganizeSnapshot(
  groups: readonly GroupSnapshot[],
  command: Extract<BatchGroupCommand, { action: 'organize' }>,
): void {
  // Compare the same visible projection returned by GET; hidden singleton metadata
  // remains restorable state, but cannot be required in a client-observed snapshot.
  const selected = new Set(command.threadIds);
  const relevant = new Map(
    groups
      .filter((group) => group.id === command.groupId || group.threadIds.some((id) => selected.has(id)))
      .map((group) => [group.id, group.threadIds]),
  );
  if (command.groupId && !relevant.has(command.groupId)) throw new ThreadAttentionGroupConflict();
  if (relevant.size !== command.expectedGroups.length) throw new ThreadAttentionGroupConflict();
  for (const group of command.expectedGroups) {
    if (JSON.stringify(relevant.get(group.id)) !== JSON.stringify(group.threadIds)) {
      throw new ThreadAttentionGroupConflict();
    }
    relevant.delete(group.id);
  }
}

export function buildGroupUndo(
  before: ReadonlyMap<string, Membership>,
  after: ReadonlyMap<string, Membership>,
): GroupUndoEntry[] {
  const changedIds = new Set(
    [...after].filter(([id, value]) => !equalMembership(before.get(id), value)).map(([id]) => id),
  );
  const affectedGroups = new Set<string>();
  for (const id of changedIds) {
    const oldGroup = before.get(id)?.groupId;
    const newGroup = after.get(id)?.groupId;
    if (oldGroup) affectedGroups.add(oldGroup);
    if (newGroup) affectedGroups.add(newGroup);
  }
  return [...before]
    .filter(([id, value]) => {
      const next = after.get(id);
      return (
        changedIds.has(id) || (value && affectedGroups.has(value.groupId)) || (next && affectedGroups.has(next.groupId))
      );
    })
    .map(([threadId, value]) => ({ threadId, before: value, after: after.get(threadId) ?? null }));
}

/** The REST boundary authenticates before-state; compare its whole current affected closure. */
export function restoreGroupSnapshot(state: Map<string, Membership>, entries: readonly GroupUndoEntry[]): void {
  const ids = new Set(entries.map((entry) => entry.threadId));
  const groups = new Set(
    entries.flatMap((entry) => [entry.before?.groupId, entry.after?.groupId].filter((id): id is string => Boolean(id))),
  );
  for (const entry of entries) {
    if (!equalMembership(state.get(entry.threadId), entry.after)) throw new ThreadAttentionGroupConflict();
  }
  for (const [id, value] of state) {
    if (value && groups.has(value.groupId) && !ids.has(id)) throw new ThreadAttentionGroupConflict();
  }
  for (const entry of entries) state.set(entry.threadId, entry.before);
}
