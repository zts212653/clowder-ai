import { type ProcessTalkMode, type ProcessTalkPreference, processTalkModeSchema } from '@cat-cafe/shared';
import { readUserPreferencesStrict, updateUserPreferences } from './user-preferences-store.js';

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unreadable process-talk preference');
  return value as Record<string, unknown>;
}

export function readProcessTalkPreference(projectRoot: string, ownerUserId: string): ProcessTalkPreference {
  const owners = record(record(readUserPreferencesStrict(projectRoot).processTalk).owners);
  const saved = Object.hasOwn(owners, ownerUserId) ? record(owners[ownerUserId]) : {};
  return { ownerUserId, mode: processTalkModeSchema.parse(saved.mode ?? 'whole') };
}

export function saveProcessTalkPreference(
  projectRoot: string,
  ownerUserId: string,
  mode: ProcessTalkMode,
): ProcessTalkPreference {
  updateUserPreferences(projectRoot, (current) => {
    const lane = record(current.processTalk);
    const owners = current.processTalk?.owners ?? {};
    record(owners);
    return { ...current, processTalk: { ...lane, owners: { ...owners, [ownerUserId]: { mode } } } };
  });
  return { ownerUserId, mode };
}
