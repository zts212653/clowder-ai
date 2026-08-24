'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chatStore';
import { useLabelStore } from '@/stores/label-store';
import {
  projectSidebarRows,
  type SidebarSnapshotRow,
  useSidebarProjectionStore,
} from '@/stores/sidebarProjectionStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { executeSidebarFieldCommand } from '@/utils/sidebar-commands';
import {
  bootstrapSidebarThreadSnapshot,
  invalidateSidebarProjection,
  refreshSidebarThreadSnapshot,
} from '@/utils/sidebar-thread-snapshot';
import { BootcampListModal } from '../BootcampListModal';
import { BootcampIcon } from '../icons/BootcampIcon';
import { readProjectNames, writeProjectNames } from './active-workspace';
import { DirectoryPickerModal, type NewThreadOptions } from './DirectoryPickerModal';
import { LabelFilterBar } from './LabelFilterBar';
import { SectionGroup } from './SectionGroup';
import { SidebarTabIcon } from './SidebarTabIcon';
import {
  createSidebarTabState,
  readBrowserSidebarTabPreference,
  sidebarTabReducer,
  writeBrowserSidebarTabPreference,
} from './sidebar-tab-state';
import { ThreadItem } from './ThreadItem';
import { ThreadOrganizerModal } from './ThreadOrganizerModal';
import { openTheaterReplay } from './theater-navigation';
import { pushThreadRouteWithHistory } from './thread-navigation';
import {
  buildSidebarTabContent,
  buildSidebarTabs,
  getProjectPaths,
  naturalTabForThread,
  projectDisplayName,
  type SidebarTabId,
  type ThreadGroup,
} from './thread-utils';
import { useCollapseState } from './use-collapse-state';
import { useProjectPins } from './use-project-pins';
import { useScrollAnchor } from './use-scroll-anchor';
import { VIRTUAL_THREAD_LIST_THRESHOLD, VirtualThreadList, type VirtualThreadListHandle } from './VirtualThreadList';

interface ThreadSidebarProps {
  onClose?: () => void;
  className?: string;
  /** URL/layout truth used to gate the one-time initial tab bootstrap. */
  routeThreadId: string;
}

interface TrashedThread {
  id: string;
  title: string | null;
}

function notifyThreadCreate(type: 'success' | 'error' | 'info', title: string, message: string) {
  useToastStore.getState().addToast({
    type,
    title,
    message,
    duration: 6000,
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function findReconciledThread(beforeThreadIds: ReadonlySet<string>, opts: NewThreadOptions): SidebarSnapshotRow | null {
  const expectedTitle = opts.title;
  if (!expectedTitle?.trim()) return null;
  const expectedProjectPath = opts.projectPath ?? 'default';
  const candidates = useSidebarProjectionStore
    .getState()
    .rows.filter(
      (row) => !beforeThreadIds.has(row.id) && row.projectPath === expectedProjectPath && row.title === expectedTitle,
    );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function groupKeyForSection(group: ThreadGroup<SidebarSnapshotRow>): string {
  return group.projectPath ?? group.type;
}

function projectSectionLabel(group: ThreadGroup<SidebarSnapshotRow>, projectNames: Map<string, string>): string {
  const projectPath = group.projectPath;
  if (!projectPath) return group.label;
  return projectNames.get(projectPath) ?? group.label;
}

function forProjectPath<T>(projectPath: string | undefined, build: (projectPath: string) => T): T | undefined {
  if (!projectPath) return undefined;
  return build(projectPath);
}

function forOpenableProject<T>(projectPath: string | undefined, build: (projectPath: string) => T): T | undefined {
  if (!projectPath) return undefined;
  if (projectPath === 'default') return undefined;
  return build(projectPath);
}

export function ThreadSidebar({ onClose, className, routeThreadId }: ThreadSidebarProps) {
  const [showBootcampList, setShowBootcampList] = useState(false);
  const { currentThreadId, setCurrentProject } = useChatStore(
    useShallow((s) => ({
      currentThreadId: s.currentThreadId,
      setCurrentProject: s.setCurrentProject,
    })),
  );
  const { rows, pendingThreadCommands, refreshing } = useSidebarProjectionStore(
    useShallow((state) => ({
      rows: state.rows,
      pendingThreadCommands: state.pendingThreadCommands,
      refreshing: state.refreshing,
    })),
  );
  const threads = useMemo(() => projectSidebarRows({ rows, pendingThreadCommands }), [pendingThreadCommands, rows]);
  const isLoadingThreads = refreshing;
  const [creationPhase, setCreationPhase] = useState<'idle' | 'submitting' | 'reconciling'>('idle');
  const isCreating = creationPhase !== 'idle';
  const [showPicker, setShowPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [bindWarning, setBindWarning] = useState<string | null>(null);
  // I-1: Thread to confirm deletion (null = no dialog)
  const [deleteTarget, setDeleteTarget] = useState<SidebarSnapshotRow | null>(null);
  // F095 Phase D: Trash bin state
  const [showTrash, setShowTrash] = useState(false);
  const [trashedThreads, setTrashedThreads] = useState<TrashedThread[]>([]);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  // F070: governance health by project path
  const [govHealth, setGovHealth] = useState<Record<string, string>>({});
  const [tabState, dispatchTabEvent] = useReducer(sidebarTabReducer, null, () => {
    const preference = readBrowserSidebarTabPreference();
    return createSidebarTabState(preference.tab, preference.persisted);
  });
  const activeTab = tabState.activeTab;

  // F095 Phase E: scroll anchor for reorder stability
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const virtualThreadListRef = useRef<VirtualThreadListHandle>(null);
  const tabRefs = useRef<Record<SidebarTabId, HTMLButtonElement | null>>({
    pinned: null,
    recent: null,
    project: null,
    system: null,
    favorites: null,
  });
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  // F095 Phase F: custom project display names
  const [projectNames, setProjectNames] = useState(() =>
    readProjectNames(typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem: () => {} }),
  );

  const loadThreads = useCallback(async () => {
    // Run both immediately: a slow IndexedDB read must never delay or overwrite
    // a newer canonical HTTP snapshot.
    await Promise.allSettled([bootstrapSidebarThreadSnapshot(), refreshSidebarThreadSnapshot()]);
  }, []);

  useEffect(() => {
    void loadThreads();
    void useChatStore.getState().fetchGlobalBubbleDefaults();
    void useLabelStore.getState().fetchLabels();
  }, [loadThreads]);

  useEffect(() => {
    const handleOnline = () => {
      void invalidateSidebarProjection();
      void useChatStore.getState().fetchGlobalBubbleDefaults();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  useEffect(() => {
    const activeButton = tabRefs.current[activeTab];
    if (!activeButton || typeof activeButton.scrollIntoView !== 'function') return;
    activeButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  // F070: Fetch governance health for all registered external projects
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/governance/health');
        if (!res.ok) return;
        const data = (await res.json()) as { projects: { projectPath: string; status: string }[] };
        const map: Record<string, string> = {};
        for (const p of data.projects) {
          map[p.projectPath] = p.status;
        }
        setGovHealth(map);
      } catch {
        // Best effort
      }
    })();
  }, []);

  const navigateToThread = useCallback((threadId: string) => {
    pushThreadRouteWithHistory(threadId, typeof window !== 'undefined' ? window : undefined);
  }, []);

  const createInProject = useCallback(
    async (opts: NewThreadOptions) => {
      console.log('[createInProject] called with opts=', JSON.stringify(opts));
      const beforeSnapshot = useSidebarProjectionStore.getState();
      const beforeThreadIds = new Set(beforeSnapshot.rows.map((row) => row.id));
      const canReconcileByDifference = beforeSnapshot.hasCanonicalSnapshot;
      let createdThreadId: string | null = null;
      let navigationCommitted = false;
      setCreationPhase('submitting');
      setShowPicker(false);
      try {
        const res = await apiFetch(`/api/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
            ...(opts.preferredCats?.length ? { preferredCats: opts.preferredCats } : {}),
            ...(opts.title ? { title: opts.title } : {}),
            ...(opts.pinned ? { pinned: opts.pinned } : {}),
            ...(opts.backlogItemId ? { backlogItemId: opts.backlogItemId } : {}),
          }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '(no body)');
          console.error('[createInProject] POST /api/threads failed:', res.status, errBody);
          notifyThreadCreate('error', '创建线程失败', '这次创建对话没有成功，请稍后重试。');
          return;
        }
        const thread = (await res.json()) as { id?: unknown };
        if (typeof thread.id !== 'string' || thread.id.length === 0) {
          notifyThreadCreate('error', '创建线程失败', '服务器没有返回有效的对话标识，请稍后重试。');
          return;
        }
        createdThreadId = thread.id;

        // F33: Bind external sessions after thread creation (best-effort, parallel)
        if (opts.sessionBindings?.length) {
          const results = await Promise.allSettled(
            opts.sessionBindings.map(({ catId, cliSessionId }) =>
              apiFetch(`/api/threads/${createdThreadId}/sessions/${catId}/bind`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cliSessionId }),
              }),
            ),
          );
          const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
          if (failed.length > 0) {
            setBindWarning(`Session 绑定部分失败（${failed.length}/${results.length}），可在 Session 面板重试`);
            setTimeout(() => setBindWarning(null), 6000);
          }
        }

        if (opts.projectPath) setCurrentProject(opts.projectPath);
        await invalidateSidebarProjection();
        navigateToThread(createdThreadId);
        navigationCommitted = true;
        // Auto-close sidebar on mobile after creating a new conversation
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          onClose?.();
        }
      } catch (err) {
        console.error('[createInProject] exception:', err);
        if (createdThreadId) {
          // The POST response is authoritative. A later projection/binding/UI
          // failure must never turn a known creation into an ambiguous result.
          if (!navigationCommitted) navigateToThread(createdThreadId);
          return;
        }
        if (isTimeoutError(err)) {
          setCreationPhase('reconciling');
          const refreshed = await invalidateSidebarProjection();
          const reconciledThread =
            refreshed && canReconcileByDifference ? findReconciledThread(beforeThreadIds, opts) : null;
          if (reconciledThread) {
            if (reconciledThread.projectPath !== 'default') setCurrentProject(reconciledThread.projectPath);
            notifyThreadCreate('success', '创建已确认', '请求虽然超时，但服务器已确认创建完成；没有重复提交。');
            navigateToThread(reconciledThread.id);
            if (typeof window !== 'undefined' && window.innerWidth < 768) onClose?.();
          } else {
            notifyThreadCreate(
              'info',
              '创建结果未确认',
              '请求已超时；已核对服务器，但仍无法确认是否创建。我们没有自动重试，请先检查侧栏。',
            );
          }
        } else {
          notifyThreadCreate('error', '创建线程失败', '创建请求没有完成，请稍后重试。');
        }
      } finally {
        setCreationPhase('idle');
      }
    },
    [setCurrentProject, navigateToThread, onClose],
  );

  // F095 Phase D: Load trashed threads
  const loadTrash = useCallback(async () => {
    setIsLoadingTrash(true);
    try {
      const res = await apiFetch('/api/threads?deleted=true');
      if (!res.ok) return;
      const data = await res.json();
      setTrashedThreads(data.threads ?? []);
    } catch {
      // Silently ignore
    } finally {
      setIsLoadingTrash(false);
    }
  }, []);

  const handleToggleTrash = useCallback(() => {
    setShowTrash((prev) => {
      const next = !prev;
      if (next) void loadTrash();
      return next;
    });
  }, [loadTrash]);

  const handleRestore = useCallback(
    async (threadId: string) => {
      try {
        const res = await apiFetch(`/api/threads/${threadId}/restore`, { method: 'POST' });
        if (!res.ok) return;
        await loadThreads();
        await loadTrash();
      } catch {
        // Silently ignore
      }
    },
    [loadThreads, loadTrash],
  );

  // I-1: Show confirmation dialog instead of deleting immediately
  const handleDeleteRequest = useCallback(
    (threadId: string) => {
      const thread = threads.find((t) => t.id === threadId);
      if (thread) setDeleteTarget(thread);
    },
    [threads],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const threadId = deleteTarget.id;
    const isSystem = deleteTarget.isHubThread || !!deleteTarget.systemKind;
    setDeleteTarget(null);
    try {
      // P1-2: System threads require ?force=true (backend enforced)
      const url = isSystem ? `/api/threads/${threadId}?force=true` : `/api/threads/${threadId}`;
      const res = await apiFetch(url, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) return;
      if (threadId === currentThreadId) {
        navigateToThread('default');
      }
      await loadThreads();
      // F095 Phase D: Refresh trash bin if visible
      if (showTrash) void loadTrash();
    } catch {
      // Silently ignore
    }
  }, [deleteTarget, currentThreadId, navigateToThread, loadThreads, showTrash, loadTrash]);

  const handleRename = useCallback(async (threadId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    const ok = await executeSidebarFieldCommand({
      threadId,
      field: 'title',
      value: nextTitle,
      request: (signal) =>
        apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
          signal,
        }),
    });
    if (!ok) {
      useToastStore.getState().addToast({
        type: 'error',
        title: '重命名失败',
        message: '服务器没有接受这次修改，已恢复权威标题。',
        duration: 5000,
      });
    }
  }, []);

  const handleTogglePin = useCallback((threadId: string, pinned: boolean) => {
    void executeSidebarFieldCommand({
      threadId,
      field: 'pinned',
      value: pinned,
      request: (signal) =>
        apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned }),
          signal,
        }),
    }).then((ok) => {
      if (!ok) {
        useToastStore.getState().addToast({
          type: 'error',
          title: '置顶失败',
          message: '服务器没有接受这次修改，已恢复权威状态。',
          duration: 5000,
        });
      }
    });
  }, []);

  const handleToggleFavorite = useCallback((threadId: string, favorited: boolean) => {
    void executeSidebarFieldCommand({
      threadId,
      field: 'favorited',
      value: favorited,
      request: (signal) =>
        apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favorited }),
          signal,
        }),
    });
  }, []);

  const handleUpdatePreferredCats = useCallback(async (threadId: string, cats: string[]) => {
    const ok = await executeSidebarFieldCommand({
      threadId,
      field: 'preferredCats',
      value: cats,
      request: (signal) =>
        apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferredCats: cats }),
          signal,
        }),
    });
    if (!ok) throw new Error('保存失败');
  }, []);

  const handleUpdateLabels = useCallback(async (threadId: string, labels: string[]) => {
    const ok = await executeSidebarFieldCommand({
      threadId,
      field: 'labels',
      value: labels,
      request: (signal) =>
        apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels }),
          signal,
        }),
    });
    if (!ok) throw new Error('保存失败');
  }, []);

  // F252 Phase E: route replay to the always-mounted AppShell host.
  const handleReplay = useCallback((threadId: string) => openTheaterReplay(threadId), []);

  const handleSelect = useCallback(
    (threadId: string) => {
      // Always clear unread badge — user clicking the thread = "I've seen it"
      useSidebarProjectionStore.getState().beginSidebarCommand(threadId, 'attention', {
        unreadCount: 0,
        hasUserMention: false,
      });
      useChatStore.getState().clearUnread(threadId);
      if (threadId === currentThreadId) return;
      // Let the new thread restore projectPath after the route switch.
      // Pre-navigation global store writes can stall SPA thread navigation.
      navigateToThread(threadId);
      // Auto-close sidebar on mobile after selecting a thread
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        onClose?.();
      }
    },
    [currentThreadId, navigateToThread, onClose],
  );

  // F095 Phase F: Project action handlers
  const handleOpenInFinder = useCallback(async (path: string) => {
    await apiFetch('/api/workspace/reveal-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: path }),
    });
  }, []);

  const handleRenameProject = useCallback((path: string, name: string) => {
    setProjectNames((prev) => {
      const next = new Map(prev);
      // If name matches default, remove override
      if (name === projectDisplayName(path)) {
        next.delete(path);
      } else {
        next.set(path, name);
      }
      writeProjectNames(next, localStorage);
      return next;
    });
  }, []);

  const handleArchiveThreads = useCallback(
    async (path: string) => {
      // P1-1: Exclude system threads — they have separate delete protection.
      const targets = threads.filter(
        (t) => t.projectPath === path && t.id !== 'default' && !t.isHubThread && !t.systemKind,
      );
      await Promise.allSettled(targets.map((t) => apiFetch(`/api/threads/${t.id}`, { method: 'DELETE' })));
      // P2-1: If current thread was archived, redirect to default
      if (currentThreadId && targets.some((t) => t.id === currentThreadId)) {
        navigateToThread('default');
      }
      await loadThreads();
      if (showTrash) void loadTrash();
    },
    [threads, loadThreads, currentThreadId, navigateToThread, showTrash, loadTrash],
  );

  const handleQuickCreate = useCallback(
    (path: string) => {
      void createInProject({ projectPath: path });
    },
    [createInProject],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const liveThreads = threads;
  const filteredThreads = useMemo(() => {
    if (!normalizedQuery) return liveThreads;
    return liveThreads.filter((thread) => {
      const title = (thread.title ?? '').toLowerCase();
      const fallback = (thread.id === 'default' ? '大厅' : '未命名对话').toLowerCase();
      const project = (thread.projectPath ?? '').toLowerCase();
      const threadId = thread.id.toLowerCase();
      return (
        title.includes(normalizedQuery) ||
        fallback.includes(normalizedQuery) ||
        project.includes(normalizedQuery) ||
        threadId.includes(normalizedQuery)
      );
    });
  }, [liveThreads, normalizedQuery]);

  const { labels } = useLabelStore();

  const labelFilteredThreads = useMemo(() => {
    if (!labelFilter) return filteredThreads;
    if (labelFilter === '__uncategorized__') {
      return filteredThreads.filter((t) => !t.labels || t.labels.length === 0);
    }
    return filteredThreads.filter((t) => t.labels?.includes(labelFilter));
  }, [filteredThreads, labelFilter]);

  const labelAssignableThreads = useMemo(() => liveThreads.filter((t) => t.id !== 'default'), [liveThreads]);

  const uncategorizedCount = useMemo(
    () => labelAssignableThreads.filter((t) => !t.labels || t.labels.length === 0).length,
    [labelAssignableThreads],
  );

  const [showOrganizer, setShowOrganizer] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Map<string, string[]> | undefined>();
  const pendingNewLabelsRef = useRef<{ name: string; color: string }[]>([]);
  const pendingNameAssignmentsRef = useRef<Map<string, string[]>>(new Map());

  const uncategorizedThreads = useMemo(
    () => labelAssignableThreads.filter((t) => !t.labels || t.labels.length === 0),
    [labelAssignableThreads],
  );

  const ORGANIZER_TITLE = 'Thread 整理助手';

  const buildTriggerContent = useCallback(() => {
    const uncatList = uncategorizedThreads
      .slice(0, 50)
      .map((t) => `- id: "${t.id}" title: "${t.title || t.id}"`)
      .join('\n');

    if (labels.length > 0) {
      const labelInfo = labels.map((l) => `${l.name} (${l.id})`).join(', ');
      return [
        '帮我整理未分类的 thread。',
        '',
        `当前有 ${uncategorizedThreads.length} 个未分类 thread，可用标签：${labelInfo}`,
        '',
        '## 未分类 Thread',
        uncatList,
        '',
        '请在回复末尾附上机器可读建议（用 HTML 注释包裹，modal 会自动解析）：',
        '<!-- SUGGESTIONS_JSON:{"threadId1":["labelId1"],"threadId2":["labelId2","labelId3"]} -->',
        'key = thread id，value = 建议的 label id 数组。只用上面列出的 id。',
      ].join('\n');
    }

    return [
      '帮我整理未分类的 thread。当前没有任何标签，请先建议一套标签体系再分类。',
      '',
      `当前有 ${uncategorizedThreads.length} 个未分类 thread（无标签）`,
      '',
      '## 未分类 Thread',
      uncatList,
      '',
      '请在回复末尾附上机器可读建议（用 HTML 注释包裹，modal 会自动解析）：',
      '<!-- SUGGESTIONS_JSON:{"newLabels":[{"name":"标签名","color":"#hex"}],"assignments":{"threadId1":["标签名"]}} -->',
      'newLabels = 建议创建的标签（名称+十六进制颜色），assignments = 每个 thread 建议的标签名数组。',
    ].join('\n');
  }, [labels, uncategorizedThreads]);

  const findOrCreateOrganizerThread = useCallback(async () => {
    const existing = useSidebarProjectionStore.getState().rows.find((thread) => thread.title === ORGANIZER_TITLE);
    if (existing) return existing;

    const res = await apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ORGANIZER_TITLE }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const created = await res.json();
    await loadThreads();
    return created as { id: string };
  }, [loadThreads]);

  const parseSuggestionsJson = useCallback(
    async (jsonStr: string) => {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const validThreadIds = new Set(uncategorizedThreads.map((t) => t.id));
      if ('newLabels' in parsed) {
        const { extractPendingLabelSuggestions } = await import('@/utils/batch-apply-labels');
        const result = extractPendingLabelSuggestions(parsed, validThreadIds);
        if (!result) return new Map<string, string[]>();
        pendingNewLabelsRef.current = result.pendingLabels;
        pendingNameAssignmentsRef.current = result.nameAssignments;
        const map = new Map<string, string[]>();
        for (const [tid, names] of result.nameAssignments) {
          map.set(
            tid,
            names.map((n) => `pending:${n}`),
          );
        }
        return map;
      }
      pendingNewLabelsRef.current = [];
      pendingNameAssignmentsRef.current = new Map();
      const { filterSuggestions } = await import('@/utils/batch-apply-labels');
      const validLabelIds = new Set(labels.map((l) => l.id));
      return filterSuggestions(parsed, validThreadIds, validLabelIds);
    },
    [uncategorizedThreads, labels],
  );

  const handleOrganizeWithCat = useCallback(async () => {
    setShowOrganizer(true);
    setSuggestLoading(true);
    setSuggestions(undefined);
    try {
      const target = await findOrCreateOrganizerThread();
      const threadId = target.id;
      const sentAt = Date.now();

      const triggerRes = await apiFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: buildTriggerContent(), threadId }),
      });
      if (!triggerRes.ok) {
        useToastStore
          .getState()
          .addToast({ type: 'error', title: '发送失败', message: '触发消息发送失败，请重试', duration: 5000 });
        return;
      }

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const msgRes = await apiFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=5`);
        if (!msgRes.ok) continue;
        const data = await msgRes.json();
        const catMsgs = (data.messages ?? []).filter(
          (m: { catId?: string; timestamp: number; isDraft?: boolean }) =>
            m.catId && m.timestamp > sentAt && !m.isDraft,
        );
        if (catMsgs.length === 0) continue;
        const withJson = catMsgs.find((m: { content: string }) => /<!-- SUGGESTIONS_JSON:/.test(m.content as string));
        if (!withJson) continue;
        const match = (withJson.content as string).match(/<!-- SUGGESTIONS_JSON:([\s\S]*?) -->/);
        if (match?.[1]) {
          try {
            setSuggestions(await parseSuggestionsJson(match[1]));
          } catch {
            /* JSON malformed — modal stays usable without pre-fill */
          }
          break;
        }
      }
    } catch {
      useToastStore
        .getState()
        .addToast({ type: 'error', title: '分析失败', message: '猫猫无法分析，请重试', duration: 5000 });
    } finally {
      setSuggestLoading(false);
    }
  }, [findOrCreateOrganizerThread, buildTriggerContent, parseSuggestionsJson]);

  const handleSuggestAll = useCallback(async () => {
    setSuggestLoading(true);
    setSuggestions(undefined);
    try {
      const target = await findOrCreateOrganizerThread();
      const threadId = target.id;
      const sentAt = Date.now();

      const triggerRes = await apiFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: buildTriggerContent(), threadId }),
      });
      if (!triggerRes.ok) return;

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const msgRes = await apiFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=5`);
        if (!msgRes.ok) continue;
        const data = await msgRes.json();
        const catMsgs = (data.messages ?? []).filter(
          (m: { catId?: string; timestamp: number; isDraft?: boolean }) =>
            m.catId && m.timestamp > sentAt && !m.isDraft,
        );
        if (catMsgs.length === 0) continue;
        const withJson = catMsgs.find((m: { content: string }) => /<!-- SUGGESTIONS_JSON:/.test(m.content as string));
        if (!withJson) continue;
        const match = (withJson.content as string).match(/<!-- SUGGESTIONS_JSON:([\s\S]*?) -->/);
        if (match?.[1]) {
          try {
            setSuggestions(await parseSuggestionsJson(match[1]));
          } catch {
            /* JSON malformed — modal stays usable without pre-fill */
          }
          break;
        }
      }
    } catch {
      /* network error — loading will stop, modal stays usable */
    } finally {
      setSuggestLoading(false);
    }
  }, [findOrCreateOrganizerThread, buildTriggerContent, parseSuggestionsJson]);

  const handleBatchApplyLabels = useCallback(async (assignments: Map<string, string[]>) => {
    const { batchApplyLabels, createAndResolveLabels } = await import('@/utils/batch-apply-labels');
    const updateLabels = async (threadId: string, labels: string[]) => {
      const ok = await executeSidebarFieldCommand({
        threadId,
        field: 'labels',
        value: labels,
        request: (signal) =>
          apiFetch(`/api/threads/${threadId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labels }),
            signal,
          }),
      });
      if (!ok) throw new Error(`failed to update labels for ${threadId}`);
    };

    let resolvedAssignments = assignments;
    if (pendingNewLabelsRef.current.length > 0) {
      const { useLabelStore } = await import('@/stores/label-store');
      const usedNames = new Set<string>();
      const nameAssignments = new Map<string, string[]>();
      for (const [tid, labelIds] of assignments) {
        const names = labelIds.filter((id) => id.startsWith('pending:')).map((id) => id.slice(8));
        if (names.length > 0) {
          nameAssignments.set(tid, names);
          for (const n of names) usedNames.add(n);
        }
      }
      const usedPending = pendingNewLabelsRef.current.filter((spec) => usedNames.has(spec.name));
      const resolved = await createAndResolveLabels(usedPending, nameAssignments, (name, color) =>
        useLabelStore.getState().createLabel(name, color),
      );
      resolvedAssignments = new Map<string, string[]>();
      for (const [tid, labelIds] of assignments) {
        const realIds = labelIds.filter((id) => !id.startsWith('pending:'));
        const newIds = resolved.get(tid) ?? [];
        const merged = [...realIds, ...newIds];
        if (merged.length > 0) resolvedAssignments.set(tid, merged);
      }
      setSuggestions(resolvedAssignments);
      pendingNewLabelsRef.current = [];
      pendingNameAssignmentsRef.current = new Map();
    }

    const { failedThreadIds } = await batchApplyLabels(resolvedAssignments, updateLabels);
    if (failedThreadIds.length === 0) {
      setSuggestions(undefined);
      setShowOrganizer(false);
    }
    return { failedThreadIds };
  }, []);

  const unreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      if (thread.unreadCount > 0) ids.add(thread.id);
    }
    return ids;
  }, [threads]);

  // F072: Mark all threads as read
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const handleMarkAllRead = useCallback(async () => {
    setIsMarkingAllRead(true);
    const commandIds = threads
      .filter((thread) => thread.unreadCount > 0 || thread.hasUserMention)
      .map((thread) =>
        useSidebarProjectionStore.getState().beginSidebarCommand(thread.id, 'attention', {
          unreadCount: 0,
          hasUserMention: false,
        }),
      );
    try {
      const res = await apiFetch('/api/threads/read/mark-all', { method: 'POST' });
      if (res.ok) {
        useChatStore.getState().clearAllUnread();
        await invalidateSidebarProjection();
      } else {
        for (const commandId of commandIds) useSidebarProjectionStore.getState().failSidebarCommand(commandId);
      }
    } catch (err) {
      for (const commandId of commandIds) useSidebarProjectionStore.getState().failSidebarCommand(commandId);
      console.debug('[F072] mark-all-read failed:', err);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, [threads]);

  // V9 sidebar tabs: keep grouping derived from filtered thread data.
  const { pinnedProjects, toggleProjectPin } = useProjectPins();
  const tabs = useMemo(
    () => buildSidebarTabs(labelFilteredThreads, pinnedProjects, unreadIds),
    [labelFilteredThreads, pinnedProjects, unreadIds],
  );
  const activeTabContent = useMemo(
    () => buildSidebarTabContent(activeTab, labelFilteredThreads, pinnedProjects, unreadIds),
    [activeTab, labelFilteredThreads, pinnedProjects, unreadIds],
  );
  const recentThreadIds = useMemo(
    () =>
      new Set(
        buildSidebarTabContent('recent', labelFilteredThreads, pinnedProjects, unreadIds).threads.map(
          (thread) => thread.id,
        ),
      ),
    [labelFilteredThreads, pinnedProjects, unreadIds],
  );
  const currentThread = useMemo(
    () => labelFilteredThreads.find((thread) => thread.id === currentThreadId),
    [labelFilteredThreads, currentThreadId],
  );
  const projectThreadGroups = useMemo(
    () => buildSidebarTabContent('project', labelFilteredThreads, pinnedProjects, unreadIds).projectGroups ?? [],
    [labelFilteredThreads, pinnedProjects, unreadIds],
  );
  const unfilteredProjectThreadGroups = useMemo(
    () => buildSidebarTabContent('project', liveThreads, pinnedProjects, unreadIds).projectGroups ?? [],
    [liveThreads, pinnedProjects, unreadIds],
  );
  const unfilteredRecentThreadIds = useMemo(
    () =>
      new Set(
        buildSidebarTabContent('recent', liveThreads, pinnedProjects, unreadIds).threads.map((thread) => thread.id),
      ),
    [liveThreads, pinnedProjects, unreadIds],
  );
  const threadGroups = activeTab === 'project' ? projectThreadGroups : [];

  const filterKey =
    normalizedQuery.length === 0 && labelFilter === null ? '' : JSON.stringify([normalizedQuery, labelFilter]);

  useEffect(() => {
    const firstNonEmptyTab = tabs.find((tab) => tab.count > 0);
    dispatchTabEvent({
      type: 'filter-reconciled',
      filterKey,
      activeTabHasThreads: activeTabContent.threads.length > 0,
      firstNonEmptyTab: firstNonEmptyTab ? firstNonEmptyTab.id : null,
    });
  }, [activeTabContent.threads.length, filterKey, tabs]);

  useEffect(() => {
    if (tabState.initialThreadResolved) return;
    if (currentThreadId !== routeThreadId) return;
    if (routeThreadId === 'default') {
      dispatchTabEvent({
        type: 'initial-thread-reconciled',
        visibleInActiveTab: true,
        destinationTab: null,
      });
      return;
    }
    if (!currentThread) return;
    dispatchTabEvent({
      type: 'initial-thread-reconciled',
      visibleInActiveTab: activeTabContent.threads.some((thread) => thread.id === currentThread.id),
      destinationTab: naturalTabForThread(currentThread, recentThreadIds),
    });
  }, [
    activeTabContent.threads,
    currentThread,
    currentThreadId,
    recentThreadIds,
    routeThreadId,
    tabState.initialThreadResolved,
  ]);

  const handleSelectTab = useCallback(
    (tab: SidebarTabId) => {
      writeBrowserSidebarTabPreference(tab);
      dispatchTabEvent({ type: 'user-selected-tab', tab, filterKey });
    },
    [filterKey],
  );

  // Tab overflow scroll: show arrow buttons when tabs overflow the row
  const updateTabScrollState = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    tabScrollRef.current?.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    updateTabScrollState();
  }, [tabs, updateTabScrollState]);

  useEffect(() => {
    window.addEventListener('resize', updateTabScrollState);
    const el = tabScrollRef.current;
    let observer: ResizeObserver | undefined;
    if (el) {
      observer = new ResizeObserver(() => updateTabScrollState());
      observer.observe(el);
    }
    return () => {
      window.removeEventListener('resize', updateTabScrollState);
      observer?.disconnect();
    };
  }, [updateTabScrollState]);

  const existingProjects = useMemo(() => getProjectPaths(liveThreads), [liveThreads]);
  const hasLabelFilters = labels.length > 0 || uncategorizedCount > 0;
  const showTabRow = tabs.length > 0 || hasLabelFilters;
  const activeTabIsEmpty =
    activeTabContent.kind === 'project' ? threadGroups.length === 0 : activeTabContent.threads.length === 0;

  // F095 Phase E: Scroll anchor — keeps visible content in place when threads reorder
  const { onScroll: handleScrollAnchor } = useScrollAnchor(scrollContainerRef, projectThreadGroups);

  // F095: Collapse state with localStorage persistence + search/active auto-expand
  const { isCollapsed, toggleGroup, expandAll, collapseAll } = useCollapseState({
    threadGroups: projectThreadGroups,
    searchQuery: normalizedQuery,
    currentThreadId,
  });
  const sidebarWidthClass = className === undefined ? 'w-60' : className;

  const scrollToActiveThread = useCallback(() => {
    if (!currentThreadId || !scrollContainerRef.current) return;
    const activeThread = liveThreads.find((thread) => thread.id === currentThreadId);
    if (!activeThread) return;

    const needsFilterClear = searchQuery.trim() !== '' || labelFilter !== null;
    if (searchQuery.trim()) setSearchQuery('');
    if (labelFilter) setLabelFilter(null);

    const ownerKeys: string[] = [];
    for (const group of unfilteredProjectThreadGroups) {
      if (!group.threads.some((thread) => thread.id === currentThreadId)) continue;
      ownerKeys.push(groupKeyForSection(group));
      const archivedOwner = group.archivedGroups?.find((archivedGroup) =>
        archivedGroup.threads.some((thread) => thread.id === currentThreadId),
      );
      if (archivedOwner) ownerKeys.push(groupKeyForSection(archivedOwner));
      break;
    }
    const collapsedOwnerKeys = ownerKeys.filter(isCollapsed);
    const needsGroupExpand = collapsedOwnerKeys.length > 0;
    for (const ownerKey of collapsedOwnerKeys) toggleGroup(ownerKey);

    const targetTab = naturalTabForThread(activeThread, unfilteredRecentThreadIds);
    const targetFlatThreads =
      targetTab === 'project'
        ? null
        : buildSidebarTabContent(targetTab, liveThreads, pinnedProjects, unreadIds).threads;
    const needsTabSwitch = activeTab !== targetTab;
    if (needsTabSwitch) handleSelectTab(targetTab);

    const scrollAndHighlight = (allowVirtualScroll = true) => {
      const element = Array.from(
        scrollContainerRef.current?.querySelectorAll<HTMLElement>('[data-thread-id]') ?? [],
      ).find((candidate) => candidate.dataset.threadId === currentThreadId);
      if (!element) {
        if (allowVirtualScroll && targetFlatThreads) {
          const index = targetFlatThreads.findIndex((thread) => thread.id === currentThreadId);
          if (index >= 0 && virtualThreadListRef.current) {
            virtualThreadListRef.current.scrollToIndex(index);
            requestAnimationFrame(() => scrollAndHighlight(false));
          }
        }
        return;
      }
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      element.classList.add('ring-2', 'ring-cafe-accent', 'ring-opacity-60');
      setTimeout(() => element.classList.remove('ring-2', 'ring-cafe-accent', 'ring-opacity-60'), 1200);
    };

    if (needsFilterClear || needsGroupExpand || needsTabSwitch) {
      requestAnimationFrame(() => requestAnimationFrame(() => scrollAndHighlight()));
    } else {
      scrollAndHighlight();
    }
  }, [
    activeTab,
    currentThreadId,
    handleSelectTab,
    isCollapsed,
    labelFilter,
    liveThreads,
    pinnedProjects,
    searchQuery,
    toggleGroup,
    unfilteredProjectThreadGroups,
    unfilteredRecentThreadIds,
    unreadIds,
  ]);

  const renderThreadItem = useCallback(
    (thread: SidebarSnapshotRow, indented = false) => (
      <ThreadItem
        key={thread.id}
        id={thread.id}
        title={thread.title}
        participants={thread.participants}
        lastActiveAt={thread.lastActiveAt}
        isActive={currentThreadId === thread.id}
        onSelect={handleSelect}
        onDelete={handleDeleteRequest}
        onRename={handleRename}
        onTogglePin={handleTogglePin}
        onToggleFavorite={handleToggleFavorite}
        onUpdatePreferredCats={handleUpdatePreferredCats}
        onUpdateLabels={handleUpdateLabels}
        onReplay={handleReplay}
        isPinned={thread.pinned}
        isFavorited={thread.favorited}
        presence={thread.presence}
        unreadCount={thread.unreadCount}
        hasUserMention={thread.hasUserMention}
        projectPath={thread.projectPath}
        indented={indented}
        preferredCats={thread.preferredCats}
        threadLabels={thread.labels}
        isHubThread={thread.isHubThread}
        systemKind={thread.systemKind}
      />
    ),
    [
      currentThreadId,
      handleDeleteRequest,
      handleRename,
      handleReplay,
      handleSelect,
      handleToggleFavorite,
      handleTogglePin,
      handleUpdateLabels,
      handleUpdatePreferredCats,
    ],
  );

  const renderProjectSection = useCallback(
    (group: ThreadGroup<SidebarSnapshotRow>) => {
      const groupKey = groupKeyForSection(group);
      const projectPath = group.projectPath;

      return (
        <SectionGroup
          key={groupKey}
          label={projectSectionLabel(group, projectNames)}
          count={group.threads.length}
          isCollapsed={isCollapsed(groupKey)}
          onToggle={() => toggleGroup(groupKey)}
          projectPath={projectPath}
          governanceStatus={forProjectPath(projectPath, (path) => govHealth[path])}
          onToggleProjectPin={forProjectPath(projectPath, (path) => () => toggleProjectPin(path))}
          isProjectPinned={forProjectPath(projectPath, (path) => pinnedProjects.has(path))}
          onQuickCreate={forProjectPath(projectPath, (path) => () => handleQuickCreate(path))}
          onOpenInFinder={forOpenableProject(projectPath, (path) => () => handleOpenInFinder(path))}
          onRenameProject={forProjectPath(projectPath, (path) => (name: string) => handleRenameProject(path, name))}
          onArchiveThreads={forProjectPath(projectPath, (path) => () => handleArchiveThreads(path))}
        >
          {group.threads.map((thread) => renderThreadItem(thread, true))}
        </SectionGroup>
      );
    },
    [
      govHealth,
      handleArchiveThreads,
      handleOpenInFinder,
      handleQuickCreate,
      handleRenameProject,
      isCollapsed,
      pinnedProjects,
      projectNames,
      renderThreadItem,
      toggleGroup,
      toggleProjectPin,
    ],
  );

  const renderProjectTabGroup = useCallback(
    (group: ThreadGroup<SidebarSnapshotRow>) => {
      const groupKey = groupKeyForSection(group);
      if (group.type !== 'archived-container') return renderProjectSection(group);

      return (
        <SectionGroup
          key={groupKey}
          label={group.label}
          icon="archive"
          count={group.threads.length}
          isCollapsed={isCollapsed(groupKey)}
          onToggle={() => toggleGroup(groupKey)}
        >
          {group.archivedGroups?.map((archivedGroup) => renderProjectSection(archivedGroup))}
        </SectionGroup>
      );
    },
    [isCollapsed, renderProjectSection, toggleGroup],
  );

  return (
    <>
      <aside className={`${sidebarWidthClass} bg-[var(--console-panel-bg)] flex flex-col h-full`}>
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-cafe-black">对话</span>
          <div className="flex items-center gap-1.5">
            {uncategorizedCount > 0 && (
              <button
                type="button"
                onClick={handleOrganizeWithCat}
                className="p-1.5 rounded-lg text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-conn-amber-text transition-colors"
                title={`猫猫帮你分类 (${uncategorizedCount} 未分类)`}
              >
                <SparkleIcon />
              </button>
            )}
            {uncategorizedCount > 0 && (
              <button
                type="button"
                onClick={() => setShowOrganizer(true)}
                className="p-1.5 rounded-lg text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary transition-colors"
                title={`手动批量分类 (${uncategorizedCount} 未分类)`}
              >
                <GridIcon />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowBootcampList(true)}
              className="p-1.5 rounded-lg text-cafe-accent hover:bg-accent-50 transition-colors"
              title="猫猫训练营"
              data-testid="sidebar-bootcamp"
              data-guide-id="sidebar.bootcamp"
            >
              <BootcampIcon className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              disabled={isCreating}
              className="console-button-primary text-xs disabled:opacity-40"
              data-guide-id="sidebar.new-thread"
            >
              {creationPhase === 'reconciling' ? '请求超时，核对中…' : isCreating ? '...' : '+ 新对话'}
            </button>
          </div>
        </div>

        {bindWarning && (
          <div className="px-3 py-1.5 bg-conn-amber-bg border-b border-conn-amber-ring text-micro text-conn-amber-text">
            {bindWarning}
          </div>
        )}

        <div className="px-3 pb-2">
          <div className="flex items-center gap-1.5">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话、项目或 ID..."
              className="flex-1 min-w-0 rounded-lg bg-[var(--console-card-soft-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary placeholder:text-cafe-muted focus:outline-none focus:ring-1 focus:ring-[var(--console-input-stroke)]"
            />
            {unreadIds.size > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={isMarkingAllRead}
                className="shrink-0 rounded-md bg-transparent px-2 py-0.5 text-micro text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe-black disabled:opacity-40 transition-colors whitespace-nowrap"
                data-testid="mark-all-read-btn"
              >
                {isMarkingAllRead ? '...' : '全部已读'}
              </button>
            )}
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          onScroll={handleScrollAnchor}
          className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--cafe-text-muted)_72%,transparent)_transparent] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-[3px] [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb]:[background-color:color-mix(in_srgb,var(--cafe-text-muted)_72%,transparent)]"
        >
          {isLoadingThreads && threads.length === 0 && (
            <div className="text-center py-4 text-xs text-cafe-muted">加载中...</div>
          )}

          {showTabRow && (
            <div
              className="sticky top-0 z-10 flex items-stretch border-b border-cafe-subtle bg-[var(--console-panel-bg)] pt-2 px-2"
              data-testid="sidebar-tabs-row"
              data-scroll-occluder="true"
            >
              {canScrollLeft && (
                <button
                  type="button"
                  onClick={() => scrollTabs('left')}
                  className="flex flex-shrink-0 items-center justify-center w-5 rounded-t-md text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
                  aria-label="向左滚动"
                  data-testid="sidebar-tab-scroll-left"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
              )}
              <div
                ref={tabScrollRef}
                onScroll={updateTabScrollState}
                className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                data-testid="sidebar-tabs-scroll"
              >
                <div className="flex w-max mx-auto" role="tablist" aria-label="对话分类">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      ref={(node) => {
                        tabRefs.current[tab.id] = node;
                      }}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      onClick={() => handleSelectTab(tab.id)}
                      className={`flex flex-shrink-0 items-center gap-1 rounded-t-md border-b-2 px-1.5 py-1.5 text-micro font-medium transition-colors ${
                        activeTab === tab.id
                          ? 'border-cafe-accent text-cafe-accent'
                          : 'border-transparent text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary'
                      }`}
                      data-testid={`sidebar-tab-${tab.id}`}
                    >
                      <SidebarTabIcon id={tab.id} className="h-3.5 w-3.5 shrink-0" />
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <LabelFilterBar
                labels={labels}
                selectedFilter={labelFilter}
                onSelect={setLabelFilter}
                uncategorizedCount={uncategorizedCount}
              />
              {canScrollRight && (
                <button
                  type="button"
                  onClick={() => scrollTabs('right')}
                  className="flex flex-shrink-0 items-center justify-center w-5 rounded-t-md text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
                  aria-label="向右滚动"
                  data-testid="sidebar-tab-scroll-right"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              )}
            </div>
          )}

          <div className="space-y-1 pt-1.5" data-testid="sidebar-tab-content">
            {activeTabContent.kind === 'flat' && (
              <>
                <div
                  className="flex items-center justify-between px-3 py-1 text-micro text-cafe-muted"
                  data-testid="flat-toolbar"
                >
                  <span>{activeTabContent.threads.length} 个对话</span>
                  <button
                    type="button"
                    onClick={scrollToActiveThread}
                    className="flex items-center justify-center rounded p-1 text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
                    data-testid="select-open-session-btn"
                    aria-label="定位当前对话"
                    title="定位当前对话"
                  >
                    <LocateThreadIcon />
                  </button>
                </div>
                {activeTabContent.threads.length >= VIRTUAL_THREAD_LIST_THRESHOLD ? (
                  <VirtualThreadList
                    ref={virtualThreadListRef}
                    threads={activeTabContent.threads}
                    scrollContainerRef={scrollContainerRef}
                    renderItem={renderThreadItem}
                  />
                ) : (
                  activeTabContent.threads.map((thread) => renderThreadItem(thread))
                )}
              </>
            )}

            {activeTabContent.kind === 'project' && threadGroups.length > 0 && (
              <div
                className="flex items-center justify-between px-3 py-1 text-micro text-cafe-muted"
                data-testid="project-toolbar"
              >
                <span>{threadGroups.length} 个项目</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={scrollToActiveThread}
                    className="flex items-center justify-center rounded p-1 text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
                    data-testid="project-select-open-session-btn"
                    aria-label="定位当前对话"
                    title="定位当前对话"
                  >
                    <LocateThreadIcon />
                  </button>
                  <button
                    type="button"
                    onClick={expandAll}
                    className="flex items-center justify-center rounded p-1 text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
                    data-testid="expand-all-btn"
                    aria-label="展开全部项目"
                    title="展开全部"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.4}
                    >
                      <path d="M5 7l3-3 3 3" />
                      <path d="M5 9l3 3 3-3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={collapseAll}
                    className="flex items-center justify-center rounded p-1 text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
                    data-testid="collapse-all-btn"
                    aria-label="折叠全部项目"
                    title="折叠全部"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.4}
                    >
                      <path d="M5 4l3 3 3-3" />
                      <path d="M5 12l3-3 3 3" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {activeTabContent.kind === 'project' && threadGroups.map((group) => renderProjectTabGroup(group))}

            {(normalizedQuery.length > 0 || labelFilter) && activeTabIsEmpty && (
              <div className="px-3 py-4 text-xs text-cafe-muted">没有匹配的对话</div>
            )}
          </div>
        </div>

        {/* F095 Phase D: Trash bin section */}
        <div className="mx-2 mt-1 mb-2">
          <button
            type="button"
            onClick={handleToggleTrash}
            className="flex w-full items-center gap-2 h-9 px-2.5 rounded-xl bg-[var(--console-card-soft-bg)] text-xs text-cafe-secondary hover:text-cafe-accent transition-colors"
            data-testid="trash-bin-toggle"
          >
            <svg
              aria-hidden="true"
              className="h-[15px] w-[15px] flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            <span className="flex-1 text-left">
              回收站{trashedThreads.length > 0 ? ` (${trashedThreads.length})` : ''}
            </span>
            <svg
              aria-hidden="true"
              className={`h-3 w-3 flex-shrink-0 transition-transform ${showTrash ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {showTrash && (
            <div className="max-h-48 overflow-y-auto mt-1">
              {isLoadingTrash && <div className="px-3 py-2 text-micro text-cafe-muted">加载中...</div>}
              {!isLoadingTrash && trashedThreads.length === 0 && (
                <div className="px-3 py-2 text-micro text-cafe-muted">回收站是空的</div>
              )}
              {trashedThreads.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)] rounded-lg group"
                >
                  <span className="truncate flex-1">{t.title ?? '未命名对话'}</span>
                  <button
                    type="button"
                    onClick={() => handleRestore(t.id)}
                    className="sm:opacity-0 sm:group-hover:opacity-100 text-micro text-cafe-accent hover:text-cafe-interactive transition-all shrink-0"
                    data-testid={`restore-btn-${t.id}`}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {showPicker && (
        <DirectoryPickerModal
          existingProjects={existingProjects}
          onSelect={createInProject}
          onCancel={() => setShowPicker(false)}
        />
      )}

      {/* I-1: Delete confirmation dialog (F095-G: typed confirmation for system threads) */}
      {deleteTarget && (
        <DeleteConfirmDialog
          thread={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}

      <BootcampListModal
        open={showBootcampList}
        onClose={() => setShowBootcampList(false)}
        currentThreadId={currentThreadId}
      />

      {showOrganizer && (
        <ThreadOrganizerModal
          open={showOrganizer}
          onClose={() => {
            setShowOrganizer(false);
            setSuggestions(undefined);
            pendingNewLabelsRef.current = [];
            pendingNameAssignmentsRef.current = new Map();
          }}
          threads={uncategorizedThreads}
          labels={[
            ...labels,
            ...pendingNewLabelsRef.current.map((spec) => ({
              id: `pending:${spec.name}`,
              name: spec.name,
              color: spec.color,
              sortOrder: 0,
              createdBy: 'auto',
              createdAt: Date.now(),
            })),
          ]}
          onApply={handleBatchApplyLabels}
          onSuggestAll={handleSuggestAll}
          initialSuggestions={suggestions}
          loading={suggestLoading}
        />
      )}
    </>
  );
}

function LocateThreadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
    >
      <circle cx="8" cy="8" r="5.5" />
      <line x1="8" y1="2.5" x2="8" y2="6" />
      <line x1="8" y1="10" x2="8" y2="13.5" />
      <line x1="2.5" y1="8" x2="6" y2="8" />
      <line x1="10" y1="8" x2="13.5" y2="8" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
      <path d="M20 3v4M22 5h-4" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/**
 * F095 Phase G: Delete confirmation dialog.
 * System threads (IM Hub) require typed confirmation (like GitHub repo deletion).
 * Regular threads show a simple confirm/cancel.
 */
function DeleteConfirmDialog({
  thread,
  onCancel,
  onConfirm,
}: {
  thread: SidebarSnapshotRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isSystem = thread.isHubThread || !!thread.systemKind;
  const title = thread.title ?? '未命名对话';
  const [typedName, setTypedName] = useState('');
  const confirmed = !isSystem || typedName === title;
  const confirmInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSystem) confirmInputRef.current?.focus();
  }, [isSystem]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-medium)] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-cafe-surface rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold text-cafe mb-2">{isSystem ? '删除系统对话' : '确认删除对话'}</h3>
        <p className="text-sm text-cafe-secondary mb-1">即将删除「{title}」</p>
        {isSystem ? (
          <>
            <p className="text-xs text-conn-red-text mb-2">
              这是系统级对话。删除可能影响平台功能（连接器路由、定时评估或猫的私人空间）。
            </p>
            <p className="text-xs text-cafe-secondary mb-2">请输入对话名称以确认删除：</p>
            <input
              ref={confirmInputRef}
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={title}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-cafe focus:outline-none focus:border-conn-red-ring mb-4"
            />
          </>
        ) : (
          <p className="text-xs text-cafe-secondary mb-4">
            对话将移入回收站，30 天后自动清理。你可以随时从回收站恢复。
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg border border-cafe hover:bg-cafe-surface-elevated transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed}
            className={`px-3 py-1.5 text-sm rounded-lg text-[var(--cafe-surface)] transition-colors ${
              isSystem
                ? 'bg-conn-red-text hover:bg-conn-red-hover disabled:bg-conn-red-ring disabled:cursor-not-allowed'
                : 'bg-conn-amber-text hover:bg-conn-amber-hover'
            }`}
          >
            {isSystem ? '确认删除' : '移入回收站'}
          </button>
        </div>
      </div>
    </div>
  );
}
