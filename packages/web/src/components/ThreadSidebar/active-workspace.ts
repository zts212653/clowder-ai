/**
 * F095 Phase B: Active workspace logic (pure functions, no React).
 * Splits project groups into active vs archived based on recency + user pins.
 */

import type { Thread } from '@/stores/chat-types';
import type { StorageLike } from './collapse-state';
import type { ThreadGroup } from './thread-utils';

export const PROJECT_PIN_KEY = 'cat-cafe:sidebar:pinned-projects';

/**
 * Get the N most recently active threads (cross-project).
 * Excludes default thread and pinned threads (those have their own section).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getRecentThreads(threads: Thread[], limit: number, _now?: number): Thread[] {
  return threads
    .filter((t) => t.id !== 'default' && !t.pinned)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, limit);
}

/** Get the most recent activity timestamp for a project path. Returns 0 if none. */
export function getProjectLatestActivity(threads: Thread[], projectPath: string): number {
  let max = 0;
  for (const t of threads) {
    if (t.projectPath === projectPath && t.lastActiveAt > max) {
      max = t.lastActiveAt;
    }
  }
  return max;
}

/**
 * Split project groups into active and archived.
 * Active = pinned OR has activity within cutoffMs of now.
 * Active sort: pinned first, then by latest activity desc.
 * Archived sort: alphabetically by projectPath.
 */
export function splitIntoActiveAndArchived(
  projectGroups: ThreadGroup[],
  allThreads: Thread[],
  pinnedProjects: Set<string>,
  cutoffMs: number,
  now: number = Date.now(),
): { active: ThreadGroup[]; archived: ThreadGroup[] } {
  const active: ThreadGroup[] = [];
  const archived: ThreadGroup[] = [];

  for (const group of projectGroups) {
    const path = group.projectPath ?? group.label;
    const isPinned = pinnedProjects.has(path);
    const latestActivity = getProjectLatestActivity(allThreads, path);
    const isActive = isPinned || now - latestActivity <= cutoffMs;

    if (isActive) {
      active.push(group);
    } else {
      archived.push(group);
    }
  }

  // Sort active: pinned first, then by latest activity desc
  active.sort((a, b) => {
    const aPath = a.projectPath ?? a.label;
    const bPath = b.projectPath ?? b.label;
    const aPinned = pinnedProjects.has(aPath) ? 1 : 0;
    const bPinned = pinnedProjects.has(bPath) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const aActivity = getProjectLatestActivity(allThreads, aPath);
    const bActivity = getProjectLatestActivity(allThreads, bPath);
    return bActivity - aActivity;
  });

  // Sort archived alphabetically
  archived.sort((a, b) => {
    const aPath = a.projectPath ?? a.label;
    const bPath = b.projectPath ?? b.label;
    return aPath.localeCompare(bPath);
  });

  return { active, archived };
}

// F095 Phase F: Custom project display names
export const PROJECT_NAME_KEY = 'cat-cafe:sidebar:project-names';

/** Read custom project display names from storage. */
export function readProjectNames(storage: StorageLike): Map<string, string> {
  try {
    const raw = storage.getItem(PROJECT_NAME_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return new Map(Object.entries(parsed as Record<string, string>));
      }
    }
  } catch {
    // storage unavailable or corrupted
  }
  return new Map();
}

/** Persist custom project display names to storage. */
export function writeProjectNames(names: Map<string, string>, storage: StorageLike): void {
  try {
    storage.setItem(PROJECT_NAME_KEY, JSON.stringify(Object.fromEntries(names)));
  } catch {
    // Best effort
  }
}

/** Read pinned project paths from storage. */
export function readPinnedProjects(storage: StorageLike): Set<string> {
  try {
    const raw = storage.getItem(PROJECT_PIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((k: unknown) => typeof k === 'string')) {
        return new Set(parsed as string[]);
      }
    }
  } catch {
    // storage unavailable or corrupted
  }
  return new Set();
}

/** Persist pinned project paths to storage. */
export function writePinnedProjects(projects: Set<string>, storage: StorageLike): void {
  try {
    storage.setItem(PROJECT_PIN_KEY, JSON.stringify([...projects]));
  } catch {
    // Best effort
  }
}
