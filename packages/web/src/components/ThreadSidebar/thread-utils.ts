import type { SidebarPresence, SidebarSystemKind } from '@/stores/sidebarProjectionStore';
import { getRecentThreads, splitIntoActiveAndArchived } from './active-workspace';

export interface SidebarThreadShape {
  readonly id: string;
  readonly title: string | null;
  readonly projectPath: string;
  readonly lastActiveAt: number;
  readonly pinned?: boolean;
  readonly favorited?: boolean;
  readonly systemKind?: SidebarSystemKind | null;
  readonly isHubThread?: boolean;
  readonly presence?: SidebarPresence;
}

type ThreadProjectSummary = Pick<SidebarThreadShape, 'projectPath' | 'lastActiveAt'>;

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

export function formatSidebarStatusTime(presence: SidebarPresence, lastActiveAt: number, now = Date.now()): string {
  return presence.status === 'working'
    ? presence.activeSince === undefined
      ? '执行中'
      : `执行中 · ${Math.max(0, Math.floor((now - presence.activeSince) / 60_000))}分`
    : formatRelativeTime(lastActiveAt, true);
}

export function projectDisplayName(path: string): string {
  if (path === 'default') return '未分类';
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function getProjectPaths(threads: readonly ThreadProjectSummary[]): string[] {
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
export interface ThreadGroup<T extends SidebarThreadShape = SidebarThreadShape> {
  type: 'pinned' | 'recent' | 'project' | 'archived-container' | 'favorites' | 'system';
  label: string;
  threads: T[];
  projectPath?: string;
  /** For archived-container: nested project groups */
  archivedGroups?: ThreadGroup<T>[];
}

export type SidebarTabId = 'pinned' | 'recent' | 'project' | 'system' | 'favorites';

export interface SidebarTab {
  id: SidebarTabId;
  label: string;
  count: number;
}

export interface SidebarThreadBucket<T extends SidebarThreadShape = SidebarThreadShape> {
  kind: 'flat' | 'project';
  threads: T[];
  projectGroups?: ThreadGroup<T>[];
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
 * Canonical working order: working rows before inactive rows, then keep
 * concurrent work stable by its owner-truth start time. Missing starts sort
 * after known starts; equal/missing starts fall back to thread id instead of
 * mutable local arrival order.
 */
function compareCanonicalWorkingOrder<T extends SidebarThreadShape>(a: T, b: T): number | undefined {
  const aWorking = a.presence?.status === 'working';
  const bWorking = b.presence?.status === 'working';
  if (aWorking !== bWorking) return aWorking ? -1 : 1;
  if (!aWorking) return undefined;

  const aActiveSince = a.presence?.activeSince;
  const bActiveSince = b.presence?.activeSince;
  const activeSinceOrder = (aActiveSince ?? Number.MAX_SAFE_INTEGER) - (bActiveSince ?? Number.MAX_SAFE_INTEGER);
  if (activeSinceOrder !== 0) return activeSinceOrder;
  return a.id.localeCompare(b.id);
}

/** Sort comparator: canonical working order, unread, then lastActiveAt descending. */
function sortByWorkingUnreadActivity<T extends SidebarThreadShape>(a: T, b: T, unreadIds?: Set<string>): number {
  const workingOrder = compareCanonicalWorkingOrder(a, b);
  if (workingOrder !== undefined) return workingOrder;
  if (unreadIds) {
    const aUnread = unreadIds.has(a.id) ? 1 : 0;
    const bUnread = unreadIds.has(b.id) ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
  }
  return b.lastActiveAt - a.lastActiveAt;
}

function isSystemThread<T extends SidebarThreadShape>(thread: T): boolean {
  return thread.id === 'default' || !!thread.systemKind || thread.isHubThread === true;
}

export function naturalTabForThread<T extends SidebarThreadShape>(
  thread: T,
  recentThreadIds: ReadonlySet<string>,
): SidebarTabId {
  if (thread.pinned) return 'pinned';
  if (isSystemThread(thread)) return 'system';
  if (recentThreadIds.has(thread.id)) return 'recent';
  if (thread.favorited) return 'favorites';
  return 'project';
}

function titleForSort<T extends SidebarThreadShape>(thread: T): string {
  return thread.title ?? (thread.id === 'default' ? '大厅' : '未命名对话');
}

/**
 * Sort comparator: pinned first, then canonical working order, unread, and
 * lastActiveAt descending.
 * Preserves the unread-first visibility that the pre-tab sidebar had via
 * `sortByWorkingUnreadActivity`, but with pin taking precedence (matches the
 * tab helpers' existing pin-first contract).
 */
function sortPinnedWorkingUnreadActivity<T extends SidebarThreadShape>(a: T, b: T, unreadIds: Set<string>): number {
  const aPinned = a.pinned ? 1 : 0;
  const bPinned = b.pinned ? 1 : 0;
  if (aPinned !== bPinned) return bPinned - aPinned;
  const workingOrder = compareCanonicalWorkingOrder(a, b);
  if (workingOrder !== undefined) return workingOrder;
  const aUnread = unreadIds.has(a.id) ? 1 : 0;
  const bUnread = unreadIds.has(b.id) ? 1 : 0;
  if (aUnread !== bUnread) return bUnread - aUnread;
  return b.lastActiveAt - a.lastActiveAt;
}

/**
 * Sort comparator: pinned first, then canonical working order, unread, and title.
 * Unread-first within the title-sorted tabs (System/Favorites/Project) so an
 * unread thread is not buried below read threads sharing the same pin state.
 */
function sortPinnedWorkingUnreadTitle<T extends SidebarThreadShape>(a: T, b: T, unreadIds: Set<string>): number {
  const aPinned = a.pinned ? 1 : 0;
  const bPinned = b.pinned ? 1 : 0;
  if (aPinned !== bPinned) return bPinned - aPinned;
  const workingOrder = compareCanonicalWorkingOrder(a, b);
  if (workingOrder !== undefined) return workingOrder;
  const aUnread = unreadIds.has(a.id) ? 1 : 0;
  const bUnread = unreadIds.has(b.id) ? 1 : 0;
  if (aUnread !== bUnread) return bUnread - aUnread;
  return titleForSort(a).localeCompare(titleForSort(b), 'zh-Hans-CN');
}

function nonDefaultThreads<T extends SidebarThreadShape>(threads: T[]): T[] {
  return threads.filter((thread) => thread.id !== 'default');
}

function tabPinnedThreads<T extends SidebarThreadShape>(threads: T[], unreadIds: Set<string>): T[] {
  // Pinned tab — flat view of all pinned threads (additive: still appears in recent/project).
  return nonDefaultThreads(threads)
    .filter((thread) => thread.pinned)
    .sort((a, b) => sortPinnedWorkingUnreadActivity(a, b, unreadIds));
}

function tabRecentThreads<T extends SidebarThreadShape>(threads: T[], unreadIds: Set<string>): T[] {
  // Demo spec (sidebar-proposals.html line 200/848): 对话置顶 = 最近 Tab + 当前 Tab 双重置顶.
  // A pinned system thread must still appear in the recent tab (additive, not exclusive).
  // Unpinned system threads stay only in the system tab.
  const pinned = nonDefaultThreads(threads)
    .filter((thread) => thread.pinned)
    .sort((a, b) => sortPinnedWorkingUnreadActivity(a, b, unreadIds));
  // #1304: Recent tab no longer truncates (PR #3460 removed 8-item limit),
  // so candidate selection by lastActiveAt is moot — all threads are candidates.
  // Unread-first display sort within the full set is acceptable per issue.
  const recent = nonDefaultThreads(threads)
    .filter((thread) => !thread.pinned && !isSystemThread(thread))
    .sort((a, b) => sortPinnedWorkingUnreadActivity(a, b, unreadIds));
  return [...pinned, ...recent];
}

function tabProjectGroups<T extends SidebarThreadShape>(
  threads: T[],
  pinnedProjects: Set<string>,
  unreadIds: Set<string>,
  config: WorkspaceConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): ThreadGroup<T>[] {
  const grouped = new Map<string, T[]>();
  for (const thread of nonDefaultThreads(threads)) {
    if (isSystemThread(thread)) continue;
    const projectPath = thread.projectPath ?? 'default';
    if (!grouped.has(projectPath)) grouped.set(projectPath, []);
    grouped.get(projectPath)?.push(thread);
  }

  const projectGroups = [...grouped.entries()].map(([projectPath, projectThreads]) => ({
    type: 'project' as const,
    label: projectDisplayName(projectPath),
    projectPath,
    threads: projectThreads.sort((a, b) => sortPinnedWorkingUnreadTitle(a, b, unreadIds)),
  }));

  const { active, archived } = splitIntoActiveAndArchived(
    projectGroups,
    threads,
    pinnedProjects,
    config.activeCutoffMs,
    now,
  );
  if (archived.length === 0) return active;

  return [
    ...active,
    {
      type: 'archived-container' as const,
      label: `其他项目 (${archived.length})`,
      threads: archived.flatMap((group) => group.threads),
      archivedGroups: archived,
    },
  ];
}

function tabSystemThreads<T extends SidebarThreadShape>(threads: T[], unreadIds: Set<string>): T[] {
  return threads.filter(isSystemThread).sort((a, b) => sortPinnedWorkingUnreadTitle(a, b, unreadIds));
}

function tabFavoriteThreads<T extends SidebarThreadShape>(threads: T[], unreadIds: Set<string>): T[] {
  return nonDefaultThreads(threads)
    .filter((thread) => thread.favorited)
    .sort((a, b) => sortPinnedWorkingUnreadTitle(a, b, unreadIds));
}

export function buildSidebarTabs<T extends SidebarThreadShape>(
  threads: T[],
  pinnedProjects: Set<string> = new Set(),
  unreadIds: Set<string> = new Set(),
  config: WorkspaceConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): SidebarTab[] {
  const projectCount = tabProjectGroups(threads, pinnedProjects, unreadIds, config, now).reduce(
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

export function buildSidebarTabContent<T extends SidebarThreadShape>(
  tabId: SidebarTabId,
  threads: T[],
  pinnedProjects: Set<string> = new Set(),
  unreadIds: Set<string> = new Set(),
  config: WorkspaceConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): SidebarThreadBucket<T> {
  if (tabId === 'pinned') {
    return { kind: 'flat', threads: tabPinnedThreads(threads, unreadIds) };
  }
  if (tabId === 'project') {
    const projectGroups = tabProjectGroups(threads, pinnedProjects, unreadIds, config, now);
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
export function sortAndGroupThreads<T extends SidebarThreadShape>(
  threads: T[],
  unreadIds?: Set<string>,
): ThreadGroup<T>[] {
  const groups: ThreadGroup<T>[] = [];

  // 1. Pinned threads (unread first, then by lastActiveAt desc)
  const pinned = threads
    .filter((t) => t.pinned && t.id !== 'default')
    .sort((a, b) => sortByWorkingUnreadActivity(a, b, unreadIds));
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
    .sort((a, b) => sortByWorkingUnreadActivity(a, b, unreadIds));
  if (favorited.length > 0) {
    groups.push({ type: 'favorites', label: '收藏', threads: favorited });
  }

  return groups;
}

/**
 * Sort and group threads with active workspace layout:
 * pinned → recent → active projects → archived-container → favorites
 */
export function sortAndGroupThreadsWithWorkspace<T extends SidebarThreadShape>(
  threads: T[],
  unreadIds: Set<string> | undefined,
  pinnedProjects: Set<string>,
  config: WorkspaceConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): ThreadGroup<T>[] {
  const groups: ThreadGroup<T>[] = [];

  // 1. Pinned threads
  const pinned = threads
    .filter((t) => t.pinned && t.id !== 'default')
    .sort((a, b) => sortByWorkingUnreadActivity(a, b, unreadIds));
  if (pinned.length > 0) {
    groups.push({ type: 'pinned', label: '置顶', threads: pinned });
  }

  // F095 Phase G + F192 livefix: System threads (IM Hub + eval domains) — dedicated section
  // Pinned system threads still appear here — pinned is additive, not exclusive
  const systemThreads = threads.filter(isSystemThread).sort((a, b) => sortByWorkingUnreadActivity(a, b, unreadIds));
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
  const allProjectGroups: ThreadGroup<T>[] = projectGroupEntries.map(([projectPath, projectThreads]) => ({
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
    .sort((a, b) => sortByWorkingUnreadActivity(a, b, unreadIds));
  if (favorited.length > 0) {
    groups.push({ type: 'favorites', label: '收藏', threads: favorited });
  }

  return groups;
}

function groupByProject<T extends SidebarThreadShape>(threads: T[], unreadIds?: Set<string>): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const thread of threads) {
    const key = thread.projectPath;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(thread);
  }
  // Sort threads within each project group
  for (const [, projectThreads] of groups) {
    projectThreads.sort((a, b) => sortByWorkingUnreadActivity(a, b, unreadIds));
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === 'default') return 1;
    if (b === 'default') return -1;
    return a.localeCompare(b);
  });
}
