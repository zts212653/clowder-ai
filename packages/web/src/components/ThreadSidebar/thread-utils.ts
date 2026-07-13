import type { Thread, ThreadState } from '@/stores/chat-types';
import { getRecentThreads, splitIntoActiveAndArchived } from './active-workspace';

export function formatRelativeTime(ts: number, compact = false): string {
  const diff = Date.now() - ts;
  if (compact) {
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}时`;
    return `${Math.floor(diff / 86400_000)}天`;
  }
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  return `${Math.floor(diff / 86400_000)}天前`;
}

export function projectDisplayName(path: string): string {
  if (path === 'default') return '未分类';
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function getProjectPaths(threads: Thread[]): string[] {
  const paths = new Set<string>();
  for (const t of threads) {
    if (t.projectPath && t.projectPath !== 'default') {
      paths.add(t.projectPath);
    }
  }
  // F095 Phase C (AC-C4): Sort by most recent thread activity, not alphabetically
  const pathList = [...paths];
  const activityMap = new Map<string, number>();
  for (const t of threads) {
    if (t.projectPath && t.projectPath !== 'default') {
      const current = activityMap.get(t.projectPath) ?? 0;
      if (t.lastActiveAt > current) activityMap.set(t.projectPath, t.lastActiveAt);
    }
  }
  return pathList.sort((a, b) => (activityMap.get(b) ?? 0) - (activityMap.get(a) ?? 0));
}

/** Thread group for sidebar rendering */
export interface ThreadGroup {
  type: 'pinned' | 'recent' | 'project' | 'archived-container' | 'favorites' | 'system';
  label: string;
  threads: Thread[];
  projectPath?: string;
  /** For archived-container: nested project groups */
  archivedGroups?: ThreadGroup[];
}

export type SidebarTabId = 'pinned' | 'recent' | 'project' | 'system' | 'favorites';

export interface SidebarTab {
  id: SidebarTabId;
  label: string;
  count: number;
}

export interface SidebarThreadBucket {
  kind: 'flat' | 'project';
  threads: Thread[];
  projectGroups?: ThreadGroup[];
}

type ThreadActivitySource = Pick<ThreadState, 'lastActivity'> | undefined;

/**
 * Merge live sidebar activity from per-thread UI state into thread summaries.
 * Backend `lastActiveAt` only changes when `/api/threads` is re-fetched; while a
 * background thread is actively streaming, the freshest timestamp lives in
 * `threadStates[threadId].lastActivity`.
 */
export function mergeLiveActivityIntoThreads(
  threads: Thread[],
  threadStates: Record<string, ThreadActivitySource>,
): Thread[] {
  return threads.map((thread) => {
    const liveLastActivity = threadStates[thread.id]?.lastActivity ?? 0;
    if (liveLastActivity <= thread.lastActiveAt) return thread;
    return { ...thread, lastActiveAt: liveLastActivity };
  });
}

/** Sort comparator: unread first, then by lastActiveAt descending. */
function sortByUnreadThenActive(a: Thread, b: Thread, unreadIds?: Set<string>): number {
  if (unreadIds) {
    const aUnread = unreadIds.has(a.id) ? 1 : 0;
    const bUnread = unreadIds.has(b.id) ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
  }
  return b.lastActiveAt - a.lastActiveAt;
}

function isSystemThread(thread: Thread): boolean {
  return thread.id === 'default' || !!thread.systemKind || !!thread.connectorHubState;
}

function titleForSort(thread: Thread): string {
  return thread.title ?? (thread.id === 'default' ? '大厅' : '未命名对话');
}

/**
 * Sort comparator: pinned first, then unread, then by lastActiveAt descending.
 * Preserves the unread-first visibility that the pre-tab sidebar had via
 * `sortByUnreadThenActive`, but with pin taking precedence (matches the
 * tab helpers' existing pin-first contract).
 */
function sortPinnedUnreadActive(a: Thread, b: Thread, unreadIds: Set<string>): number {
  const aPinned = a.pinned ? 1 : 0;
  const bPinned = b.pinned ? 1 : 0;
  if (aPinned !== bPinned) return bPinned - aPinned;
  const aUnread = unreadIds.has(a.id) ? 1 : 0;
  const bUnread = unreadIds.has(b.id) ? 1 : 0;
  if (aUnread !== bUnread) return bUnread - aUnread;
  return b.lastActiveAt - a.lastActiveAt;
}

/**
 * Sort comparator: pinned first, then unread, then by title.
 * Unread-first within the title-sorted tabs (System/Favorites/Project) so an
 * unread thread is not buried below read threads sharing the same pin state.
 */
function sortPinnedUnreadTitle(a: Thread, b: Thread, unreadIds: Set<string>): number {
  const aPinned = a.pinned ? 1 : 0;
  const bPinned = b.pinned ? 1 : 0;
  if (aPinned !== bPinned) return bPinned - aPinned;
  const aUnread = unreadIds.has(a.id) ? 1 : 0;
  const bUnread = unreadIds.has(b.id) ? 1 : 0;
  if (aUnread !== bUnread) return bUnread - aUnread;
  return titleForSort(a).localeCompare(titleForSort(b), 'zh-Hans-CN');
}

function nonDefaultThreads(threads: Thread[]): Thread[] {
  return threads.filter((thread) => thread.id !== 'default');
}

function tabPinnedThreads(threads: Thread[], unreadIds: Set<string>): Thread[] {
  // Pinned tab — flat view of all pinned threads (additive: still appears in recent/project).
  return nonDefaultThreads(threads)
    .filter((thread) => thread.pinned)
    .sort((a, b) => sortPinnedUnreadActive(a, b, unreadIds));
}

function tabRecentThreads(threads: Thread[], unreadIds: Set<string>): Thread[] {
  // Demo spec (sidebar-proposals.html line 200/848): 对话置顶 = 最近 Tab + 当前 Tab 双重置顶.
  // A pinned system thread must still appear in the recent tab (additive, not exclusive).
  // Unpinned system threads stay only in the system tab.
  return nonDefaultThreads(threads)
    .filter((thread) => thread.pinned || !isSystemThread(thread))
    .sort((a, b) => sortPinnedUnreadActive(a, b, unreadIds));
}

function tabSystemThreads(threads: Thread[], unreadIds: Set<string>): Thread[] {
  return threads.filter(isSystemThread).sort((a, b) => sortPinnedUnreadTitle(a, b, unreadIds));
}

function tabFavoriteThreads(threads: Thread[], unreadIds: Set<string>): Thread[] {
  return nonDefaultThreads(threads)
    .filter((thread) => thread.favorited)
    .sort((a, b) => sortPinnedUnreadTitle(a, b, unreadIds));
}

function tabProjectGroups(threads: Thread[], pinnedProjects: Set<string>, unreadIds: Set<string>): ThreadGroup[] {
  const grouped = new Map<string, Thread[]>();
  for (const thread of nonDefaultThreads(threads)) {
    if (isSystemThread(thread)) continue;
    const projectPath = thread.projectPath ?? 'default';
    if (!grouped.has(projectPath)) grouped.set(projectPath, []);
    grouped.get(projectPath)?.push(thread);
  }

  return [...grouped.entries()]
    .map(([projectPath, projectThreads]) => ({
      type: 'project' as const,
      label: projectDisplayName(projectPath),
      projectPath,
      threads: projectThreads.sort((a, b) => sortPinnedUnreadTitle(a, b, unreadIds)),
    }))
    .sort((a, b) => {
      const aPinned = pinnedProjects.has(a.projectPath ?? '') ? 1 : 0;
      const bPinned = pinnedProjects.has(b.projectPath ?? '') ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      if (a.projectPath === 'default') return 1;
      if (b.projectPath === 'default') return -1;
      return (a.projectPath ?? a.label).localeCompare(b.projectPath ?? b.label, 'zh-Hans-CN');
    });
}

export function buildSidebarTabs(
  threads: Thread[],
  pinnedProjects: Set<string> = new Set(),
  unreadIds: Set<string> = new Set(),
): SidebarTab[] {
  const projectCount = tabProjectGroups(threads, pinnedProjects, unreadIds).reduce(
    (sum, group) => sum + group.threads.length,
    0,
  );
  return [
    { id: 'pinned', label: '置顶', count: tabPinnedThreads(threads, unreadIds).length },
    { id: 'recent', label: '最近', count: tabRecentThreads(threads, unreadIds).length },
    { id: 'project', label: '项目', count: projectCount },
    { id: 'system', label: '系统', count: tabSystemThreads(threads, unreadIds).length },
    { id: 'favorites', label: '收藏', count: tabFavoriteThreads(threads, unreadIds).length },
  ];
}

export function buildSidebarTabContent(
  tabId: SidebarTabId,
  threads: Thread[],
  pinnedProjects: Set<string> = new Set(),
  unreadIds: Set<string> = new Set(),
): SidebarThreadBucket {
  if (tabId === 'pinned') {
    return { kind: 'flat', threads: tabPinnedThreads(threads, unreadIds) };
  }
  if (tabId === 'project') {
    const projectGroups = tabProjectGroups(threads, pinnedProjects, unreadIds);
    return { kind: 'project', threads: projectGroups.flatMap((group) => group.threads), projectGroups };
  }
  if (tabId === 'system') {
    return { kind: 'flat', threads: tabSystemThreads(threads, unreadIds) };
  }
  if (tabId === 'favorites') {
    return { kind: 'flat', threads: tabFavoriteThreads(threads, unreadIds) };
  }
  return { kind: 'flat', threads: tabRecentThreads(threads, unreadIds) };
}

/**
 * Sort and group threads into: pinned → project groups → favorites.
 * The "default" thread (lobby) is included in the system group.
 * Within each group: unread threads first, then by lastActiveAt descending.
 */
export function sortAndGroupThreads(threads: Thread[], unreadIds?: Set<string>): ThreadGroup[] {
  const groups: ThreadGroup[] = [];

  // 1. Pinned threads (unread first, then by lastActiveAt desc)
  const pinned = threads
    .filter((t) => t.pinned && t.id !== 'default')
    .sort((a, b) => sortByUnreadThenActive(a, b, unreadIds));
  if (pinned.length > 0) {
    groups.push({ type: 'pinned', label: '置顶', threads: pinned });
  }

  // 2. Regular threads grouped by project (each group sorted)
  // Pinned threads still appear in their project group — pinned is additive, not exclusive
  const regular = threads.filter((t) => !t.favorited && t.id !== 'default');
  const projectGroups = groupByProject(regular, unreadIds);
  for (const [projectPath, projectThreads] of projectGroups) {
    groups.push({
      type: 'project',
      label: projectDisplayName(projectPath),
      threads: projectThreads,
      projectPath,
    });
  }

  // 3. Favorites (unread first, then by lastActiveAt desc)
  // Pinned threads can also appear here if favorited — pinned is additive
  const favorited = threads
    .filter((t) => t.favorited && t.id !== 'default')
    .sort((a, b) => sortByUnreadThenActive(a, b, unreadIds));
  if (favorited.length > 0) {
    groups.push({ type: 'favorites', label: '收藏', threads: favorited });
  }

  return groups;
}

export interface WorkspaceConfig {
  activeCutoffMs: number;
  recentLimit: number;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  activeCutoffMs: 7 * 86400_000,
  recentLimit: 8,
};

/**
 * Sort and group threads with active workspace layout:
 * pinned → recent → active projects → archived-container → favorites
 */
export function sortAndGroupThreadsWithWorkspace(
  threads: Thread[],
  unreadIds: Set<string> | undefined,
  pinnedProjects: Set<string>,
  config: WorkspaceConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): ThreadGroup[] {
  const groups: ThreadGroup[] = [];

  // 1. Pinned threads
  const pinned = threads
    .filter((t) => t.pinned && t.id !== 'default')
    .sort((a, b) => sortByUnreadThenActive(a, b, unreadIds));
  if (pinned.length > 0) {
    groups.push({ type: 'pinned', label: '置顶', threads: pinned });
  }

  // F095 Phase G + F192 livefix: System threads (IM Hub + eval domains) — dedicated section
  // Pinned system threads still appear here — pinned is additive, not exclusive
  const systemThreads = threads.filter(isSystemThread).sort((a, b) => sortByUnreadThenActive(a, b, unreadIds));
  if (systemThreads.length > 0) {
    groups.push({ type: 'system', label: '系统', threads: systemThreads });
  }
  const systemIds = new Set(systemThreads.map((t) => t.id));

  // 2. Recent threads (cross-project, excluding pinned/default/system)
  const recent = getRecentThreads(threads, config.recentLimit, now).filter((t) => !systemIds.has(t.id));
  if (recent.length > 0) {
    groups.push({ type: 'recent', label: '最近对话', threads: recent });
  }

  // 3. Project groups split into active/archived (excluding system threads)
  // Pinned threads still appear in their project group — pinned is additive
  const regular = threads.filter((t) => !t.favorited && t.id !== 'default' && !systemIds.has(t.id));
  const projectGroupEntries = groupByProject(regular, unreadIds);
  const allProjectGroups: ThreadGroup[] = projectGroupEntries.map(([projectPath, projectThreads]) => ({
    type: 'project' as const,
    label: projectDisplayName(projectPath),
    threads: projectThreads,
    projectPath,
  }));

  const { active, archived } = splitIntoActiveAndArchived(
    allProjectGroups,
    threads,
    pinnedProjects,
    config.activeCutoffMs,
    now,
  );

  for (const g of active) {
    groups.push(g);
  }

  if (archived.length > 0) {
    const allArchivedThreads = archived.flatMap((g) => g.threads);
    groups.push({
      type: 'archived-container',
      label: `其他项目 (${archived.length})`,
      threads: allArchivedThreads,
      archivedGroups: archived,
    });
  }

  // 4. Favorites — pinned threads can also appear here if favorited
  const favorited = threads
    .filter((t) => t.favorited && t.id !== 'default')
    .sort((a, b) => sortByUnreadThenActive(a, b, unreadIds));
  if (favorited.length > 0) {
    groups.push({ type: 'favorites', label: '收藏', threads: favorited });
  }

  return groups;
}

function groupByProject(threads: Thread[], unreadIds?: Set<string>): [string, Thread[]][] {
  const groups = new Map<string, Thread[]>();
  for (const thread of threads) {
    const key = thread.projectPath;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(thread);
  }
  // Sort threads within each project group
  for (const [, projectThreads] of groups) {
    projectThreads.sort((a, b) => sortByUnreadThenActive(a, b, unreadIds));
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === 'default') return 1;
    if (b === 'default') return -1;
    return a.localeCompare(b);
  });
}
