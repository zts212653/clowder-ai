import { randomUUID } from 'node:crypto';
import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import type {
  IThreadStore,
  Thread,
  ThreadAttentionGroupMembershipV1,
} from '../cats/services/stores/ports/ThreadStore.js';
import {
  assertOrganizeSnapshot,
  type BatchGroupCommand,
  buildGroupUndo,
  type GroupUndoEntry,
  restoreGroupSnapshot,
  ThreadAttentionGroupConflict,
} from './thread-attention-group-batch.js';

export type ThreadAttentionGroupCommand =
  | BatchGroupCommand
  | { action: 'create'; threadIds: string[] }
  | { action: 'move'; groupId: string; threadId: string; beforeThreadId?: string }
  | { action: 'remove'; groupId: string; threadId: string };

type GroupStore = Pick<IThreadStore, 'list' | 'getThreadMetadata' | 'atomicMergeThreadMetadata'>;
type Membership = ThreadAttentionGroupMembershipV1 | null;

interface ThreadMembershipRecord {
  thread: Thread;
  membership: Membership;
}

export function isThreadAttentionGroupEligible(thread: Thread): boolean {
  return !thread.deletedAt && thread.id !== 'default' && !thread.systemKind && !thread.connectorHubState;
}

function isMembership(value: unknown): value is ThreadAttentionGroupMembershipV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ThreadAttentionGroupMembershipV1>;
  return (
    candidate.v === 1 &&
    typeof candidate.groupId === 'string' &&
    /^attention_[A-Za-z0-9_-]+$/.test(candidate.groupId) &&
    Number.isInteger(candidate.order) &&
    Number(candidate.order) >= 0
  );
}

async function readMemberships(store: GroupStore, userId: string): Promise<ThreadMembershipRecord[]> {
  const threads = (await store.list(userId)).filter(isThreadAttentionGroupEligible);
  return Promise.all(
    threads.map(async (thread) => {
      const membership = (await store.getThreadMetadata(thread.id))?.attentionGroup;
      return { thread, membership: isMembership(membership) ? { ...membership } : null };
    }),
  );
}

function compareMembers(left: ThreadMembershipRecord, right: ThreadMembershipRecord): number {
  const orderDelta = (left.membership?.order ?? 0) - (right.membership?.order ?? 0);
  return orderDelta || left.thread.createdAt - right.thread.createdAt || left.thread.id.localeCompare(right.thread.id);
}

function projectGroups(records: readonly ThreadMembershipRecord[]): ThreadAttentionGroup[] {
  const grouped = new Map<string, ThreadMembershipRecord[]>();
  for (const record of records) {
    const groupId = record.membership?.groupId;
    if (!groupId) continue;
    const members = grouped.get(groupId) ?? [];
    members.push(record);
    grouped.set(groupId, members);
  }
  return [...grouped.entries()]
    .map(([id, members]) => ({ id, threadIds: members.sort(compareMembers).map(({ thread }) => thread.id) }))
    .filter((group) => group.threadIds.length >= 2)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function resolveThreadAttentionGroups(store: GroupStore, userId: string): Promise<ThreadAttentionGroup[]> {
  return projectGroups(await readMemberships(store, userId));
}

function groupMemberIds(state: Map<string, Membership>, groupId: string): string[] {
  return [...state.entries()]
    .filter(([, membership]) => membership?.groupId === groupId)
    .sort((left, right) => (left[1]?.order ?? 0) - (right[1]?.order ?? 0) || left[0].localeCompare(right[0]))
    .map(([threadId]) => threadId);
}

function normalizeGroup(state: Map<string, Membership>, groupId: string, threadIds: readonly string[]): void {
  if (threadIds.length < 2) {
    for (const threadId of threadIds) state.set(threadId, null);
    return;
  }
  threadIds.forEach((threadId, order) => {
    state.set(threadId, { v: 1, groupId, order });
  });
}

function removeFromCurrentGroup(state: Map<string, Membership>, threadId: string): void {
  const sourceGroupId = state.get(threadId)?.groupId;
  if (!sourceGroupId) return;
  const remaining = groupMemberIds(state, sourceGroupId).filter((id) => id !== threadId);
  state.set(threadId, null);
  normalizeGroup(state, sourceGroupId, remaining);
}

function createGroup(state: Map<string, Membership>, threadIds: readonly string[]): void {
  if (threadIds.length < 2 || new Set(threadIds).size !== threadIds.length) {
    throw new Error('At least two unique threads are required');
  }
  const groupId = `attention_${randomUUID()}`;
  for (const threadId of threadIds) removeFromCurrentGroup(state, threadId);
  normalizeGroup(state, groupId, threadIds);
}

function moveThread(
  state: Map<string, Membership>,
  command: Extract<ThreadAttentionGroupCommand, { action: 'move' }>,
): void {
  const targetBeforeMove = groupMemberIds(state, command.groupId);
  if (targetBeforeMove.length < 2) throw new Error('Conversation group not found');
  removeFromCurrentGroup(state, command.threadId);
  const target = targetBeforeMove.filter((id) => id !== command.threadId);
  const index = command.beforeThreadId ? target.indexOf(command.beforeThreadId) : -1;
  if (command.beforeThreadId && index < 0) throw new Error('Target thread not found in Group');
  const next =
    index < 0 ? [...target, command.threadId] : [...target.slice(0, index), command.threadId, ...target.slice(index)];
  normalizeGroup(state, command.groupId, next);
}

function removeThread(
  state: Map<string, Membership>,
  command: Extract<ThreadAttentionGroupCommand, { action: 'remove' }>,
): void {
  if (state.get(command.threadId)?.groupId !== command.groupId) throw new Error('Conversation group not found');
  removeFromCurrentGroup(state, command.threadId);
}

function membershipEquals(left: Membership, right: Membership): boolean {
  return left?.groupId === right?.groupId && left?.order === right?.order && left?.v === right?.v;
}

async function persistState(
  store: GroupStore,
  before: Map<string, Membership>,
  after: Map<string, Membership>,
): Promise<void> {
  const changes = [...after.entries()].filter(
    ([threadId, membership]) => !membershipEquals(before.get(threadId) ?? null, membership),
  );
  const applied: string[] = [];
  try {
    for (const [threadId, membership] of changes) {
      await store.atomicMergeThreadMetadata(threadId, { attentionGroup: membership });
      applied.push(threadId);
    }
  } catch (error) {
    for (const threadId of applied.reverse()) {
      try {
        await store.atomicMergeThreadMetadata(threadId, { attentionGroup: before.get(threadId) ?? null });
      } catch {
        // Preserve the original failure; a later read exposes any incomplete rollback honestly.
      }
    }
    throw error;
  }
}

export async function applyThreadAttentionGroupCommand(
  store: GroupStore,
  userId: string,
  command: ThreadAttentionGroupCommand,
  afterPersist?: (groups: readonly ThreadAttentionGroup[], undo: GroupUndoEntry[]) => void | Promise<void>,
): Promise<ThreadAttentionGroup[]> {
  const records = await readMemberships(store, userId);
  const ownedIds = new Set(records.map(({ thread }) => thread.id));
  const requiredIds =
    command.action === 'create' || command.action === 'organize'
      ? command.threadIds
      : command.action === 'undo'
        ? command.entries.map((entry) => entry.threadId)
        : [command.threadId];
  if (requiredIds.some((threadId) => !ownedIds.has(threadId))) {
    if (command.action === 'undo') throw new ThreadAttentionGroupConflict();
    throw new Error('Thread not found');
  }

  const before = new Map(records.map(({ thread, membership }) => [thread.id, membership]));
  const after = new Map(
    [...before.entries()].map(([threadId, membership]) => [threadId, membership && { ...membership }]),
  );
  if (command.action === 'organize') {
    assertOrganizeSnapshot(projectGroups(records), command);
    if (command.groupId) {
      for (const threadId of command.threadIds) {
        if (after.get(threadId)?.groupId !== command.groupId)
          moveThread(after, { action: 'move', threadId, groupId: command.groupId });
      }
    } else createGroup(after, command.threadIds);
  } else if (command.action === 'undo') restoreGroupSnapshot(after, command.entries);
  else if (command.action === 'create') createGroup(after, command.threadIds);
  else if (command.action === 'move') moveThread(after, command);
  else removeThread(after, command);

  await persistState(store, before, after);
  const groups = projectGroups(records.map(({ thread }) => ({ thread, membership: after.get(thread.id) ?? null })));
  try {
    await afterPersist?.(groups, command.action === 'organize' ? buildGroupUndo(before, after) : []);
  } catch (error) {
    await persistState(store, after, before);
    throw error;
  }
  return groups;
}
