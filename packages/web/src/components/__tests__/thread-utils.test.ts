import { describe, expect, it } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import {
  buildSidebarTabContent,
  buildSidebarTabs,
  formatRelativeTime,
  getProjectPaths,
  mergeLiveActivityIntoThreads,
  projectDisplayName,
  type SidebarTabId,
  sortAndGroupThreads,
  sortAndGroupThreadsWithWorkspace,
} from '../ThreadSidebar/thread-utils';

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: 'default',
    title: null,
    createdBy: 'user',
    participants: [],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

// ── sortAndGroupThreads ────────────────────────────────

describe('sortAndGroupThreads', () => {
  it('returns empty array for empty input', () => {
    expect(sortAndGroupThreads([])).toEqual([]);
  });

  it('excludes the "default" thread (lobby)', () => {
    const threads = [makeThread({ id: 'default' })];
    expect(sortAndGroupThreads(threads)).toEqual([]);
  });

  it('groups regular threads by project', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/a' }),
      makeThread({ id: 't2', projectPath: '/proj/b' }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe('project');
    expect(groups[1].type).toBe('project');
    expect(groups.map((g) => g.label).sort()).toEqual(['a', 'b']);
  });

  it('puts pinned threads first, sorted by lastActiveAt desc', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/x', lastActiveAt: 500 }),
      makeThread({ id: 'p1', pinned: true, pinnedAt: 200, projectPath: '/proj/x', lastActiveAt: 1000 }),
      makeThread({ id: 'p2', pinned: true, pinnedAt: 100, projectPath: '/proj/x', lastActiveAt: 5000 }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups[0].type).toBe('pinned');
    expect(groups[0].threads.map((t) => t.id)).toEqual(['p2', 'p1']); // lastActiveAt 5000 before 1000
  });

  it('puts favorites last, sorted by lastActiveAt desc', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/x', lastActiveAt: 500 }),
      makeThread({ id: 'f1', favorited: true, favoritedAt: 100, projectPath: '/proj/x', lastActiveAt: 1000 }),
      makeThread({ id: 'f2', favorited: true, favoritedAt: 200, projectPath: '/proj/x', lastActiveAt: 5000 }),
    ];
    const groups = sortAndGroupThreads(threads);
    const last = groups[groups.length - 1];
    expect(last.type).toBe('favorites');
    expect(last.threads.map((t) => t.id)).toEqual(['f2', 'f1']); // lastActiveAt 5000 before 1000
  });

  it('pinned + favorited thread appears in pinned and favorites (pinned is additive)', () => {
    const threads = [
      makeThread({
        id: 'both',
        pinned: true,
        pinnedAt: 100,
        favorited: true,
        favoritedAt: 50,
        projectPath: '/proj/x',
      }),
      makeThread({ id: 'regular', projectPath: '/proj/x' }),
    ];
    const groups = sortAndGroupThreads(threads);
    const pinnedGroup = groups.find((g) => g.type === 'pinned');
    const favGroup = groups.find((g) => g.type === 'favorites');
    expect(pinnedGroup).toBeDefined();
    expect(pinnedGroup?.threads).toHaveLength(1);
    expect(pinnedGroup?.threads[0].id).toBe('both');
    // Pinned is additive — thread now also appears in favorites
    expect(favGroup).toBeDefined();
    expect(favGroup?.threads).toHaveLength(1);
    expect(favGroup?.threads[0].id).toBe('both');
  });

  it('pinned-only thread appears in both pinned and its project group', () => {
    const threads = [
      makeThread({ id: 'pinned-t', pinned: true, pinnedAt: 100, projectPath: '/proj/x', lastActiveAt: 5000 }),
      makeThread({ id: 'regular', projectPath: '/proj/x', lastActiveAt: 1000 }),
    ];
    const groups = sortAndGroupThreads(threads);
    const pinnedGroup = groups.find((g) => g.type === 'pinned');
    const projGroup = groups.find((g) => g.type === 'project');
    expect(pinnedGroup?.threads.map((t) => t.id)).toEqual(['pinned-t']);
    expect(projGroup?.threads.map((t) => t.id)).toContain('pinned-t');
    expect(projGroup?.threads.map((t) => t.id)).toContain('regular');
  });

  it('order is pinned → project → favorites', () => {
    const threads = [
      makeThread({ id: 'f1', favorited: true, favoritedAt: 100, projectPath: '/proj/x' }),
      makeThread({ id: 'p1', pinned: true, pinnedAt: 100, projectPath: '/proj/x' }),
      makeThread({ id: 'r1', projectPath: '/proj/x' }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups.map((g) => g.type)).toEqual(['pinned', 'project', 'favorites']);
  });

  it('omits empty groups', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/a' }),
      makeThread({ id: 't2', projectPath: '/proj/a' }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('project');
    expect(groups[0].threads).toHaveLength(2);
  });

  it('handles threads with no pinned/favorited fields (backward compat)', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/x' }),
      makeThread({ id: 't2', projectPath: '/proj/x' }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('project');
    expect(groups[0].threads).toHaveLength(2);
  });

  it('sorts regular threads within project by lastActiveAt desc', () => {
    const threads = [
      makeThread({ id: 'old', projectPath: '/proj/x', lastActiveAt: 1000 }),
      makeThread({ id: 'new', projectPath: '/proj/x', lastActiveAt: 5000 }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups[0].threads.map((t) => t.id)).toEqual(['new', 'old']);
  });

  it('sorts unread threads before read threads within pinned group', () => {
    const threads = [
      makeThread({ id: 'read-new', projectPath: '/proj/x', lastActiveAt: 9000, pinned: true }),
      makeThread({ id: 'unread-old', projectPath: '/proj/x', lastActiveAt: 1000, pinned: true }),
    ];
    const unreadSet = new Set(['unread-old']);
    const groups = sortAndGroupThreads(threads, unreadSet);
    const pinned = groups.find((g) => g.type === 'pinned')!;
    expect(pinned.threads[0].id).toBe('unread-old'); // unread first
    expect(pinned.threads[1].id).toBe('read-new');
  });

  it('within unread threads, still sorts by lastActiveAt desc', () => {
    const threads = [
      makeThread({ id: 'unread-old', projectPath: '/proj/x', lastActiveAt: 1000, pinned: true }),
      makeThread({ id: 'unread-new', projectPath: '/proj/x', lastActiveAt: 5000, pinned: true }),
    ];
    const unreadSet = new Set(['unread-old', 'unread-new']);
    const groups = sortAndGroupThreads(threads, unreadSet);
    const pinned = groups.find((g) => g.type === 'pinned')!;
    expect(pinned.threads[0].id).toBe('unread-new');
    expect(pinned.threads[1].id).toBe('unread-old');
  });

  it('unread priority works across all group types', () => {
    const threads = [
      makeThread({ id: 'fav-read', projectPath: '/proj/x', lastActiveAt: 9000, favorited: true }),
      makeThread({ id: 'fav-unread', projectPath: '/proj/x', lastActiveAt: 1000, favorited: true }),
      makeThread({ id: 'reg-read', projectPath: '/proj/x', lastActiveAt: 9000 }),
      makeThread({ id: 'reg-unread', projectPath: '/proj/x', lastActiveAt: 1000 }),
    ];
    const unreadSet = new Set(['fav-unread', 'reg-unread']);
    const groups = sortAndGroupThreads(threads, unreadSet);
    const project = groups.find((g) => g.type === 'project')!;
    expect(project.threads[0].id).toBe('reg-unread');
    const fav = groups.find((g) => g.type === 'favorites')!;
    expect(fav.threads[0].id).toBe('fav-unread');
  });

  it('no unreadIds param defaults to lastActiveAt-only sort', () => {
    const threads = [
      makeThread({ id: 'old', projectPath: '/proj/x', lastActiveAt: 1000, pinned: true }),
      makeThread({ id: 'new', projectPath: '/proj/x', lastActiveAt: 5000, pinned: true }),
    ];
    const groups = sortAndGroupThreads(threads);
    const pinned = groups.find((g) => g.type === 'pinned')!;
    expect(pinned.threads[0].id).toBe('new');
  });

  it('sorts project groups alphabetically, "default" last', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: 'default' }),
      makeThread({ id: 't2', projectPath: '/proj/b' }),
      makeThread({ id: 't3', projectPath: '/proj/a' }),
    ];
    const groups = sortAndGroupThreads(threads);
    expect(groups.map((g) => g.label)).toEqual(['a', 'b', '未分类']);
  });
});

// ── formatRelativeTime ────────────────────────────────

describe('formatRelativeTime', () => {
  it('returns "刚刚" for less than 60s', () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('刚刚');
  });

  it('returns minutes in normal mode', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5分钟前');
  });

  it('returns compact minutes', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000, true)).toBe('5分');
  });

  it('returns hours in normal mode', () => {
    expect(formatRelativeTime(Date.now() - 3 * 3600_000)).toBe('3小时前');
  });

  it('returns compact hours', () => {
    expect(formatRelativeTime(Date.now() - 3 * 3600_000, true)).toBe('3时');
  });

  it('returns days in normal mode', () => {
    expect(formatRelativeTime(Date.now() - 2 * 86400_000)).toBe('2天前');
  });

  it('returns compact days', () => {
    expect(formatRelativeTime(Date.now() - 2 * 86400_000, true)).toBe('2天');
  });
});

// ── projectDisplayName ────────────────────────────────

describe('projectDisplayName', () => {
  it('returns "未分类" for "default"', () => {
    expect(projectDisplayName('default')).toBe('未分类');
  });

  it('returns last segment of path', () => {
    expect(projectDisplayName('/home/user/my-project')).toBe('my-project');
  });

  it('handles trailing slash', () => {
    expect(projectDisplayName('/foo/bar/')).toBe('bar');
  });
});

// ── getProjectPaths ────────────────────────────────

describe('getProjectPaths', () => {
  it('returns unique non-default paths sorted by most recent activity', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/b', lastActiveAt: 1000 }),
      makeThread({ id: 't2', projectPath: '/proj/a', lastActiveAt: 5000 }),
      makeThread({ id: 't3', projectPath: '/proj/b', lastActiveAt: 2000 }),
      makeThread({ id: 't4', projectPath: 'default' }),
    ];
    // /proj/a has most recent activity (5000), then /proj/b (max 2000)
    expect(getProjectPaths(threads)).toEqual(['/proj/a', '/proj/b']);
  });

  it('returns empty for no project threads', () => {
    const threads = [makeThread({ id: 't1', projectPath: 'default' })];
    expect(getProjectPaths(threads)).toEqual([]);
  });

  it('sorts most recently active project first (AC-C4)', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/alpha', lastActiveAt: 100 }),
      makeThread({ id: 't2', projectPath: '/proj/beta', lastActiveAt: 500 }),
      makeThread({ id: 't3', projectPath: '/proj/gamma', lastActiveAt: 300 }),
    ];
    expect(getProjectPaths(threads)).toEqual(['/proj/beta', '/proj/gamma', '/proj/alpha']);
  });
});

// ── mergeLiveActivityIntoThreads ─────────────────────

describe('mergeLiveActivityIntoThreads', () => {
  it('prefers newer live activity from thread state over stale summary timestamp', () => {
    const threads = [
      makeThread({ id: 'pinned-stale', pinned: true, lastActiveAt: NOW - 10 * DAY }),
      makeThread({ id: 'pinned-fresh', pinned: true, lastActiveAt: NOW - 2 * DAY }),
    ];

    const merged = mergeLiveActivityIntoThreads(threads, {
      'pinned-stale': { lastActivity: NOW - 1_000 },
    });

    expect(merged.find((thread) => thread.id === 'pinned-stale')?.lastActiveAt).toBe(NOW - 1_000);
    expect(merged.find((thread) => thread.id === 'pinned-fresh')?.lastActiveAt).toBe(NOW - 2 * DAY);
  });
});

// ── sortAndGroupThreadsWithWorkspace ─────────────────

const NOW = 1710000000000;
const DAY = 86400_000;

describe('sortAndGroupThreadsWithWorkspace', () => {
  it('produces groups in order: pinned → recent → active projects → archived → favorites', () => {
    const threads = [
      makeThread({ id: 'p1', pinned: true, projectPath: '/proj/active', lastActiveAt: NOW }),
      makeThread({ id: 't1', projectPath: '/proj/active', lastActiveAt: NOW - 2 * DAY }),
      makeThread({ id: 't2', projectPath: '/proj/old', lastActiveAt: NOW - 30 * DAY }),
      makeThread({ id: 'f1', favorited: true, lastActiveAt: NOW - 1 * DAY }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const types = groups.map((g) => g.type);
    expect(types).toEqual(['pinned', 'recent', 'project', 'archived-container', 'favorites']);
  });

  it('recent section contains cross-project threads sorted by lastActiveAt', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/a', lastActiveAt: NOW - 5 * DAY }),
      makeThread({ id: 't2', projectPath: '/proj/b', lastActiveAt: NOW - 1 * DAY }),
      makeThread({ id: 't3', projectPath: '/proj/a', lastActiveAt: NOW }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const recent = groups.find((g) => g.type === 'recent');
    expect(recent).toBeDefined();
    expect(recent?.threads.map((t) => t.id)).toEqual(['t3', 't2', 't1']);
  });

  it('archived-container has archivedGroups with nested project groups', () => {
    const threads = [
      makeThread({ id: 't1', projectPath: '/proj/old-a', lastActiveAt: NOW - 30 * DAY }),
      makeThread({ id: 't2', projectPath: '/proj/old-b', lastActiveAt: NOW - 20 * DAY }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const archived = groups.find((g) => g.type === 'archived-container');
    expect(archived).toBeDefined();
    expect(archived?.archivedGroups).toHaveLength(2);
    expect(archived?.label).toMatch(/其他项目 \(2\)/);
  });

  it('pinned projects stay in active section even when old', () => {
    const threads = [makeThread({ id: 't1', projectPath: '/proj/old-pinned', lastActiveAt: NOW - 60 * DAY })];
    const pinnedProjects = new Set(['/proj/old-pinned']);
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      pinnedProjects,
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const active = groups.filter((g) => g.type === 'project');
    expect(active.map((g) => g.projectPath)).toContain('/proj/old-pinned');
    const archived = groups.find((g) => g.type === 'archived-container');
    expect(archived).toBeUndefined();
  });

  it('skips sections that would be empty', () => {
    const threads = [makeThread({ id: 't1', projectPath: '/proj/a', lastActiveAt: NOW - 2 * DAY })];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const types = groups.map((g) => g.type);
    expect(types).not.toContain('pinned');
    expect(types).not.toContain('favorites');
    expect(types).not.toContain('archived-container');
    expect(types).toContain('recent');
    expect(types).toContain('project');
  });

  it('floats a pinned thread to the top when live sidebar activity is newer than thread summary activity', () => {
    const threads = mergeLiveActivityIntoThreads(
      [
        makeThread({ id: 'pinned-old', pinned: true, lastActiveAt: NOW - 10 * DAY }),
        makeThread({ id: 'pinned-newer', pinned: true, lastActiveAt: NOW - 2 * DAY }),
      ],
      {
        'pinned-old': { lastActivity: NOW - 500 },
      },
    );

    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );

    const pinned = groups.find((group) => group.type === 'pinned');
    expect(pinned?.threads.map((thread) => thread.id)).toEqual(['pinned-old', 'pinned-newer']);
  });

  // F192 livefix: systemKind-based system section grouping (OQ-19)
  it('groups eval_domain threads into system section via systemKind', () => {
    const threads = [
      makeThread({ id: 'eval-thread', title: 'A2A Eval', systemKind: 'eval_domain', lastActiveAt: NOW }),
      makeThread({ id: 'regular', title: 'Chat', lastActiveAt: NOW - 1 * DAY }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const system = groups.find((g) => g.type === 'system');
    expect(system).toBeDefined();
    expect(system?.threads.map((t) => t.id)).toEqual(['eval-thread']);
    // eval thread should NOT appear in recent
    const recent = groups.find((g) => g.type === 'recent');
    expect(recent?.threads.find((t) => t.id === 'eval-thread')).toBeUndefined();
  });

  it('pinned system thread appears in BOTH pinned and system sections (pinned is additive)', () => {
    const threads = [
      makeThread({
        id: 'pinned-system',
        title: 'A2A Harness Eval',
        systemKind: 'eval_domain',
        pinned: true,
        lastActiveAt: NOW,
      }),
      makeThread({ id: 'regular-system', title: 'IM Hub', systemKind: 'connector_hub', lastActiveAt: NOW - DAY }),
      makeThread({ id: 'regular', title: 'Chat', lastActiveAt: NOW - 2 * DAY }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const pinned = groups.find((g) => g.type === 'pinned');
    const system = groups.find((g) => g.type === 'system');
    expect(pinned).toBeDefined();
    expect(pinned?.threads.map((t) => t.id)).toEqual(['pinned-system']);
    expect(system).toBeDefined();
    expect(system?.threads.map((t) => t.id)).toContain('pinned-system');
    expect(system?.threads.map((t) => t.id)).toContain('regular-system');
  });

  it('pinned regular thread appears in both pinned and its project group', () => {
    const threads = [
      makeThread({ id: 'pinned-proj', pinned: true, projectPath: '/proj/alpha', lastActiveAt: NOW }),
      makeThread({ id: 'regular-proj', projectPath: '/proj/alpha', lastActiveAt: NOW - DAY }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const pinned = groups.find((g) => g.type === 'pinned');
    const project = groups.find((g) => g.type === 'project' && g.projectPath === '/proj/alpha');
    expect(pinned?.threads.map((t) => t.id)).toEqual(['pinned-proj']);
    expect(project?.threads.map((t) => t.id)).toContain('pinned-proj');
    expect(project?.threads.map((t) => t.id)).toContain('regular-proj');
  });

  it('groups both connector_hub and eval_domain threads into system section', () => {
    const threads = [
      makeThread({
        id: 'hub-thread',
        title: 'IM Hub',
        connectorHubState: { v: 1, connectorId: 'feishu', externalChatId: '123', createdAt: NOW },
        lastActiveAt: NOW,
      }),
      makeThread({ id: 'eval-thread', title: 'Memory Eval', systemKind: 'eval_domain', lastActiveAt: NOW - DAY }),
    ];
    const groups = sortAndGroupThreadsWithWorkspace(
      threads,
      undefined,
      new Set(),
      { activeCutoffMs: 7 * DAY, recentLimit: 8 },
      NOW,
    );
    const system = groups.find((g) => g.type === 'system');
    expect(system).toBeDefined();
    expect(system?.threads).toHaveLength(2);
  });
});

// ── sidebar tab selectors ─────────────────────────────

describe('sidebar tab selectors', () => {
  const tabThreads = [
    makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
    makeThread({ id: 'regular-new', title: 'Zoo', projectPath: '/proj/beta', lastActiveAt: NOW - 1_000 }),
    makeThread({ id: 'regular-old', title: 'Alpha', projectPath: '/proj/alpha', lastActiveAt: NOW - DAY }),
    makeThread({ id: 'pinned', title: 'Pinned', pinned: true, projectPath: '/proj/beta', lastActiveAt: NOW - 2 * DAY }),
    makeThread({
      id: 'fav',
      title: 'Favorite',
      favorited: true,
      projectPath: '/proj/alpha',
      lastActiveAt: NOW - 3 * DAY,
    }),
    makeThread({ id: 'system', title: 'System', systemKind: 'eval_domain', lastActiveAt: NOW - 4 * DAY }),
  ];

  it('builds tabs with pinned first, then recent/project/system/favorites', () => {
    const tabs = buildSidebarTabs(tabThreads);
    const tabIds: SidebarTabId[] = tabs.map((tab) => tab.id);
    expect(tabIds).toEqual(['pinned', 'recent', 'project', 'system', 'favorites']);
    expect(tabs.map((tab) => tab.label)).toEqual(['置顶', '最近', '项目', '系统', '收藏']);
    // pinned tab has 1 (the pinned thread); recent still includes it (additive) so stays 4
    // system tab has 2: 'default' (lobby) + 'system' (eval_domain) — isSystemThread matches both
    expect(tabs.map((tab) => tab.count)).toEqual([1, 4, 4, 2, 1]);
  });

  it('pinned tab is a flat view of pinned threads sorted by lastActiveAt desc', () => {
    const content = buildSidebarTabContent('pinned', tabThreads, new Set());
    expect(content.kind).toBe('flat');
    expect(content.threads.map((thread) => thread.id)).toEqual(['pinned']);
  });

  it('recent tab excludes lobby and system threads, then sorts pinned first and activity desc', () => {
    const content = buildSidebarTabContent('recent', tabThreads, new Set(['/proj/alpha']));

    expect(content.kind).toBe('flat');
    expect(content.threads.map((thread) => thread.id)).toEqual(['pinned', 'regular-new', 'regular-old', 'fav']);
  });

  it('system and favorites tabs are flat isolated views', () => {
    const system = buildSidebarTabContent('system', tabThreads, new Set());
    const favorites = buildSidebarTabContent('favorites', tabThreads, new Set());

    expect(system.kind).toBe('flat');
    // 'default' (lobby) is also a system thread (id === 'default'), sorted by title: 大厅 > System
    expect(system.threads.map((thread) => thread.id)).toEqual(['default', 'system']);
    expect(favorites.kind).toBe('flat');
    expect(favorites.threads.map((thread) => thread.id)).toEqual(['fav']);
  });

  it('project tab groups non-system threads by path with pinned projects first and item titles alphabetical', () => {
    const content = buildSidebarTabContent('project', tabThreads, new Set(['/proj/beta']));

    expect(content.kind).toBe('project');
    expect(content.projectGroups?.map((group) => group.projectPath)).toEqual(['/proj/beta', '/proj/alpha']);
    expect(content.projectGroups?.[0].threads.map((thread) => thread.id)).toEqual(['pinned', 'regular-new']);
    expect(content.projectGroups?.[1].threads.map((thread) => thread.id)).toEqual(['regular-old', 'fav']);
  });

  // Regression: unread-first ordering must survive the tab rewrite.
  // The pre-tab sidebar sorted unread threads before read ones inside each
  // group; the new tab selectors must preserve that or an older unread thread
  // gets buried below a newer read one. Covers maintainer review on PR #1095.
  it('recent tab puts unread threads before read threads regardless of activity', () => {
    const threads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({ id: 'read-new', title: 'Read New', projectPath: '/proj/a', lastActiveAt: NOW - 1_000 }),
      makeThread({ id: 'unread-old', title: 'Unread Old', projectPath: '/proj/a', lastActiveAt: NOW - DAY }),
    ];
    const unreadIds = new Set(['unread-old']);

    // Without unreadIds: read-new first (newer activity wins)
    const noUnread = buildSidebarTabContent('recent', threads, new Set(), new Set());
    expect(noUnread.threads.map((t) => t.id)).toEqual(['read-new', 'unread-old']);

    // With unreadIds: unread-old first (unread takes precedence over activity)
    const withUnread = buildSidebarTabContent('recent', threads, new Set(), unreadIds);
    expect(withUnread.threads.map((t) => t.id)).toEqual(['unread-old', 'read-new']);
  });

  it('project tab sorts unread threads before read threads within a group', () => {
    const threads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({ id: 'read-new', title: 'Read New', projectPath: '/proj/a', lastActiveAt: NOW - 1_000 }),
      makeThread({ id: 'unread-old', title: 'Unread Old', projectPath: '/proj/a', lastActiveAt: NOW - DAY }),
    ];
    const unreadIds = new Set(['unread-old']);

    const content = buildSidebarTabContent('project', threads, new Set(), unreadIds);
    expect(content.kind).toBe('project');
    // Within /proj/a: unread-old before read-new, despite read-new being newer
    expect(content.projectGroups?.[0].threads.map((t) => t.id)).toEqual(['unread-old', 'read-new']);
  });

  // Regression: Locate button must switch to the correct tab when the active thread
  // is absent from the current tab. The sidebar's findTabForThread() scans all tabs
  // via buildSidebarTabContent to find membership. This test verifies the underlying
  // tab membership: a system thread is NOT in 'recent' but IS in 'system'.
  it('locates a system thread in system tab, not recent (findTabForThread regression)', () => {
    const threads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({
        id: 'eval-thread',
        title: 'Eval Runner',
        systemKind: 'eval_domain',
        lastActiveAt: NOW - 1_000,
      }),
      makeThread({ id: 'normal', title: 'Normal Thread', projectPath: '/proj/a', lastActiveAt: NOW }),
    ];

    // Simulate findTabForThread scan order: recent → system → project → pinned → favorites
    const tabOrder: SidebarTabId[] = ['recent', 'system', 'project', 'pinned', 'favorites'];
    const targetId = 'eval-thread';

    let foundTab: SidebarTabId = 'recent';
    for (const tabId of tabOrder) {
      const bucket = buildSidebarTabContent(tabId, threads, new Set());
      if (bucket.threads.some((t) => t.id === targetId)) {
        foundTab = tabId;
        break;
      }
    }

    // The system thread must be found in 'system', not 'recent'
    expect(foundTab).toBe('system');

    // Double-check: it's genuinely absent from 'recent' tab
    const recentBucket = buildSidebarTabContent('recent', threads, new Set());
    expect(recentBucket.threads.some((t) => t.id === targetId)).toBe(false);
  });
});
