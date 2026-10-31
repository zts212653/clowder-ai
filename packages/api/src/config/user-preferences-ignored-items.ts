import {
  type IgnoredItemPatch,
  type IgnoredItemSnapshot,
  ignoredItemKey,
  ignoredItemOwnerPreferenceSchema,
  type UserPreferences,
} from '@cat-cafe/shared';
import { readUserPreferencesStrict, updateUserPreferences } from './user-preferences-store.js';

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unreadable ignored item preferences');
  return value as Record<string, unknown>;
}

function snapshot(preferences: UserPreferences, ownerUserId: string): IgnoredItemSnapshot {
  const owners = record(record(preferences.ignoredItems).owners);
  const stored = Object.hasOwn(owners, ownerUserId) ? owners[ownerUserId] : undefined;
  const parsed = ignoredItemOwnerPreferenceSchema.parse(stored ?? { revision: 0, entries: [] });
  return { ownerUserId, revision: parsed.revision, entries: parsed.entries };
}

export class IgnoredItemRevisionConflict extends Error {
  constructor(readonly snapshot: IgnoredItemSnapshot) {
    super('Ignored item preferences changed; read them again before saving');
  }
}

export function readIgnoredItemPreferences(projectRoot: string, ownerUserId: string): IgnoredItemSnapshot {
  return snapshot(readUserPreferencesStrict(projectRoot), ownerUserId);
}

type IgnoredItemMutation = Omit<IgnoredItemPatch, 'expectedOwnerUserId'>;

function applyPatch(previous: IgnoredItemSnapshot, patch: IgnoredItemMutation): IgnoredItemSnapshot {
  if (previous.revision !== patch.expectedRevision) throw new IgnoredItemRevisionConflict(previous);
  const entries = new Map(previous.entries.map((entry) => [ignoredItemKey(entry.coordinate), entry]));
  for (const coordinate of patch.restore) entries.delete(ignoredItemKey(coordinate));
  const ignoredAt = Date.now();
  for (const coordinate of patch.ignore) {
    const key = ignoredItemKey(coordinate);
    if (!entries.has(key)) entries.set(key, { coordinate, ignoredAt });
  }
  const nextEntries = [...entries.values()];
  const changed = JSON.stringify(nextEntries) !== JSON.stringify(previous.entries);
  const revision = previous.revision + (changed ? 1 : 0);
  if (!Number.isSafeInteger(revision)) throw new Error('Preference revision is exhausted');
  return { ownerUserId: previous.ownerUserId, revision, entries: nextEntries };
}

export function saveIgnoredItemPreferences(
  projectRoot: string,
  ownerUserId: string,
  patch: IgnoredItemMutation,
): IgnoredItemSnapshot {
  let result: IgnoredItemSnapshot | undefined;
  updateUserPreferences(
    projectRoot,
    (current) => {
      const previous = snapshot(current, ownerUserId);
      result = applyPatch(previous, patch);
      if (result.revision === previous.revision) return current;
      const lane = record(current.ignoredItems);
      const owners = record(lane.owners);
      const stored = Object.hasOwn(owners, ownerUserId) ? record(owners[ownerUserId]) : {};
      return {
        ...current,
        ignoredItems: {
          ...lane,
          owners: { ...owners, [ownerUserId]: { ...stored, revision: result.revision, entries: result.entries } },
        },
      };
    },
    { strictRead: true },
  );
  if (!result) throw new Error('Ignored item preferences were not saved');
  return result;
}
