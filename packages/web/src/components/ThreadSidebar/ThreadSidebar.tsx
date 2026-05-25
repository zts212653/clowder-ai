'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { useLabelStore } from '@/stores/label-store';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { loadThreads as loadCachedThreads } from '@/utils/offline-store';
import { BootcampListModal } from '../BootcampListModal';
import { BootcampIcon } from '../icons/BootcampIcon';

import { readProjectNames, writeProjectNames } from './active-workspace';
import { DirectoryPickerModal, type NewThreadOptions } from './DirectoryPickerModal';
import { LabelFilterBar } from './LabelFilterBar';
import { SectionGroup } from './SectionGroup';
import { ThreadItem } from './ThreadItem';
import { ThreadOrganizerModal } from './ThreadOrganizerModal';
import { pushThreadRouteWithHistory } from './thread-navigation';
import {
  getProjectPaths,
  mergeLiveActivityIntoThreads,
  projectDisplayName,
  sortAndGroupThreadsWithWorkspace,
} from './thread-utils';
import { createToggleWithReconcile } from './toggle-with-reconcile';
import { useCollapseState } from './use-collapse-state';
import { useProjectPins } from './use-project-pins';
import { useScrollAnchor } from './use-scroll-anchor';

interface ThreadSidebarProps {
  onClose?: () => void;
  className?: string;
}

function notifyThreadCreateFailure(message: string) {
  useToastStore.getState().addToast({
    type: 'error',
    title: '创建线程失败',
    message,
    duration: 6000,
  });
}

export function ThreadSidebar({ onClose, className }: ThreadSidebarProps) {
  const [showBootcampList, setShowBootcampList] = useState(false);
  const {
    threads,
    currentThreadId,
    setThreads,
    setCurrentProject,
    isLoadingThreads,
    setLoadingThreads,
    updateThreadTitle,
    getThreadState,
    threadStates,
  } = useChatStore();
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [bindWarning, setBindWarning] = useState<string | null>(null);
  // I-1: Thread to confirm deletion (null = no dialog)
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null);
  // F095 Phase D: Trash bin state
  const [showTrash, setShowTrash] = useState(false);
  const [trashedThreads, setTrashedThreads] = useState<Thread[]>([]);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  // F070: governance health by project path
  const [govHealth, setGovHealth] = useState<Record<string, string>>({});

  // F095 Phase E: scroll anchor for reorder stability
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // F095 Phase F: custom project display names
  const [projectNames, setProjectNames] = useState(() =>
    readProjectNames(typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem: () => {} }),
  );

  // Shared seq maps — created once, cross-referenced between pin/fav toggle instances
  const pinSeqMap = useRef(new Map<string, number>());
  const favSeqMap = useRef(new Map<string, number>());

  // Stable toggle-with-reconcile instances (lazy-init in ref, survive re-renders)
  const pinToggle = useRef<ReturnType<typeof createToggleWithReconcile>>();
  const favToggle = useRef<ReturnType<typeof createToggleWithReconcile>>();
  if (!pinToggle.current) {
    pinToggle.current = createToggleWithReconcile({
      fetch: apiFetch,
      onUpdate: (id, val) => useChatStore.getState().updateThreadPin(id, val),
      field: 'pinned',
      seqMap: pinSeqMap.current,
      siblingSeqMap: favSeqMap.current,
      onUpdateSibling: (id, val) => useChatStore.getState().updateThreadFavorite(id, val),
      siblingField: 'favorited',
    });
  }
  if (!favToggle.current) {
    favToggle.current = createToggleWithReconcile({
      fetch: apiFetch,
      onUpdate: (id, val) => useChatStore.getState().updateThreadFavorite(id, val),
      field: 'favorited',
      seqMap: favSeqMap.current,
      siblingSeqMap: pinSeqMap.current,
      onUpdateSibling: (id, val) => useChatStore.getState().updateThreadPin(id, val),
      siblingField: 'pinned',
    });
  }

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);

    // F164: Cache-first — show IndexedDB snapshot immediately (skip unread init; API refresh will handle)
    try {
      const cached = await loadCachedThreads();
      if (cached && cached.length > 0) {
        setThreads(cached);
      }
    } catch {
      // IDB read failure — continue to API
    }

    // Then fetch fresh data from API (replace snapshot if successful)
    try {
      const res = await apiFetch('/api/threads');
      if (!res.ok) return;
      const data = await res.json();
      const threads = data.threads ?? [];
      setThreads(threads); // Also triggers IDB write-through via chatStore
      const { initThreadUnread } = useChatStore.getState();
      for (const thread of threads) {
        if (thread.unreadCount > 0 || thread.hasUserMention) {
          initThreadUnread(thread.id, thread.unreadCount ?? 0, !!thread.hasUserMention);
        }
      }
    } catch {
      // API failed — IDB snapshot already displayed (if available)
    } finally {
      setLoadingThreads(false);
    }
  }, [setThreads, setLoadingThreads]);

  useEffect(() => {
    void loadThreads();
    void useChatStore.getState().fetchGlobalBubbleDefaults();
    void useLabelStore.getState().fetchLabels();
  }, [loadThreads]);

  useEffect(() => {
    const handleOnline = () => {
      void loadThreads();
      void useChatStore.getState().fetchGlobalBubbleDefaults();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [loadThreads]);

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
      setIsCreating(true);
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
          notifyThreadCreateFailure('这次创建对话没有成功，请稍后重试。');
          return;
        }
        const thread: Thread = await res.json();

        // F33: Bind external sessions after thread creation (best-effort, parallel)
        if (opts.sessionBindings?.length) {
          const results = await Promise.allSettled(
            opts.sessionBindings.map(({ catId, cliSessionId }) =>
              apiFetch(`/api/threads/${thread.id}/sessions/${catId}/bind`, {
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
        navigateToThread(thread.id);
        // Auto-close sidebar on mobile after creating a new conversation
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          onClose?.();
        }
        await loadThreads();
      } catch (err) {
        console.error('[createInProject] exception:', err);
        notifyThreadCreateFailure('网络请求没有完成，创建对话失败。请稍后重试。');
      } finally {
        setIsCreating(false);
      }
    },
    [setCurrentProject, navigateToThread, loadThreads, onClose],
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
    const isSystem = !!deleteTarget.connectorHubState;
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

  const handleRename = useCallback(
    async (threadId: string, title: string) => {
      const nextTitle = title.trim();
      if (!nextTitle) return;
      try {
        const res = await apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
        });
        if (!res.ok) return;
        const updated = await res.json();
        updateThreadTitle(threadId, updated.title ?? nextTitle);
      } catch {
        // Silently ignore
      }
    },
    [updateThreadTitle],
  );

  const handleTogglePin = useCallback(
    (threadId: string, pinned: boolean) => void pinToggle.current?.toggle(threadId, pinned),
    [],
  );

  const handleToggleFavorite = useCallback(
    (threadId: string, favorited: boolean) => void favToggle.current?.toggle(threadId, favorited),
    [],
  );

  const handleUpdatePreferredCats = useCallback(async (threadId: string, cats: string[]) => {
    const res = await apiFetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredCats: cats }),
    });
    if (!res.ok) throw new Error('保存失败');
    useChatStore.getState().updateThreadPreferredCats(threadId, cats);
  }, []);

  const handleUpdateLabels = useCallback(async (threadId: string, labels: string[]) => {
    await useChatStore.getState().updateThreadLabels(threadId, labels);
  }, []);

  const handleSelect = useCallback(
    (threadId: string) => {
      // Always clear unread badge — user clicking the thread = "I've seen it"
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
      // P1-1: Exclude system threads (connectorHubState) — they have separate delete protection
      const targets = threads.filter((t) => t.projectPath === path && t.id !== 'default' && !t.connectorHubState);
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
  const liveThreads = useMemo(() => mergeLiveActivityIntoThreads(threads, threadStates), [threads, threadStates]);
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

  const uncategorizedCount = useMemo(
    () => liveThreads.filter((t) => !t.labels || t.labels.length === 0).length,
    [liveThreads],
  );

  const [showOrganizer, setShowOrganizer] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Map<string, string[]> | undefined>();
  const pendingNewLabelsRef = useRef<{ name: string; color: string }[]>([]);
  const pendingNameAssignmentsRef = useRef<Map<string, string[]>>(new Map());

  const uncategorizedThreads = useMemo(
    () => liveThreads.filter((t) => !t.labels || t.labels.length === 0),
    [liveThreads],
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
    const store = useChatStore.getState();
    const existing = store.threads.find((t) => t.title === ORGANIZER_TITLE);
    if (existing) return existing;

    const res = await apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ORGANIZER_TITLE }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const created = await res.json();
    await loadThreads();
    return created as Thread;
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
    const updateLabels = useChatStore.getState().updateThreadLabels;

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
      const ts = threadStates[thread.id];
      if (ts && ts.unreadCount > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [threads, threadStates]);

  // F072: Mark all threads as read
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const handleMarkAllRead = useCallback(async () => {
    setIsMarkingAllRead(true);
    try {
      const res = await apiFetch('/api/threads/read/mark-all', { method: 'POST' });
      if (res.ok) {
        useChatStore.getState().clearAllUnread();
      }
    } catch (err) {
      console.debug('[F072] mark-all-read failed:', err);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, []);

  // F095 Phase B: Active workspace grouping
  const { pinnedProjects, toggleProjectPin } = useProjectPins();
  const threadGroups = useMemo(
    () => sortAndGroupThreadsWithWorkspace(labelFilteredThreads, unreadIds, pinnedProjects),
    [labelFilteredThreads, unreadIds, pinnedProjects],
  );
  const existingProjects = useMemo(() => getProjectPaths(liveThreads), [liveThreads]);
  const showDefaultThread = (normalizedQuery.length === 0 || '大厅'.includes(normalizedQuery)) && !labelFilter;

  // F095 Phase E: Scroll anchor — keeps visible content in place when threads reorder
  const { onScroll: handleScrollAnchor } = useScrollAnchor(scrollContainerRef, threadGroups);

  // F095: Collapse state with localStorage persistence + search/active auto-expand
  const { isCollapsed, toggleGroup, expandAll, collapseAll } = useCollapseState({
    threadGroups,
    searchQuery: normalizedQuery,
    currentThreadId,
  });
  const sidebarWidthClass = className === undefined ? 'w-60' : className;

  return (
    <>
      <aside className={`${sidebarWidthClass} bg-[var(--console-panel-bg)] flex flex-col h-full`}>
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-cafe-black">对话</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowBootcampList(true)}
              className="p-1.5 rounded-lg text-conn-amber-text hover:bg-conn-amber-bg transition-colors"
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
              {isCreating ? '...' : '+ 新对话'}
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

        <LabelFilterBar
          labels={labels}
          selectedFilter={labelFilter}
          onSelect={setLabelFilter}
          uncategorizedCount={uncategorizedCount}
          onOrganize={handleOrganizeWithCat}
          onManualOrganize={() => setShowOrganizer(true)}
        />

        <div ref={scrollContainerRef} onScroll={handleScrollAnchor} className="flex-1 overflow-y-auto">
          {isLoadingThreads && threads.length === 0 && (
            <div className="text-center py-4 text-xs text-cafe-muted">加载中...</div>
          )}

          {showDefaultThread && (
            <ThreadItem
              id="default"
              title="大厅"
              participants={[]}
              lastActiveAt={Date.now()}
              isActive={currentThreadId === 'default'}
              onSelect={handleSelect}
              threadState={getThreadState('default')}
            />
          )}

          {threadGroups.length > 0 && (
            <div className="flex items-center justify-end px-3 pt-1.5">
              <button
                type="button"
                onClick={expandAll}
                className="text-micro text-cafe-muted hover:text-cafe-accent transition-colors"
                data-testid="expand-all-btn"
              >
                全部展开
              </button>
              <span className="text-micro text-cafe-muted mx-1">/</span>
              <button
                type="button"
                onClick={collapseAll}
                className="text-micro text-cafe-muted hover:text-cafe-accent transition-colors"
                data-testid="collapse-all-btn"
              >
                全部折叠
              </button>
            </div>
          )}

          {threadGroups.map((group) => {
            const groupKey = group.projectPath ?? group.type;
            const icon =
              group.type === 'pinned'
                ? ('pin' as const)
                : group.type === 'favorites'
                  ? ('star' as const)
                  : group.type === 'recent'
                    ? ('clock' as const)
                    : group.type === 'system'
                      ? ('system' as const)
                      : undefined;

            // Archived container: render nested project groups
            if (group.type === 'archived-container') {
              return (
                <SectionGroup
                  key="archived-container"
                  label={group.label}
                  icon="archive"
                  count={group.archivedGroups?.length ?? 0}
                  isCollapsed={isCollapsed('archived-container')}
                  onToggle={() => toggleGroup('archived-container')}
                >
                  {group.archivedGroups?.map((sub) => {
                    const subKey = sub.projectPath ?? sub.type;
                    return (
                      <SectionGroup
                        key={subKey}
                        label={sub.projectPath ? (projectNames.get(sub.projectPath) ?? sub.label) : sub.label}
                        count={sub.threads.length}
                        isCollapsed={isCollapsed(subKey)}
                        onToggle={() => toggleGroup(subKey)}
                        projectPath={sub.projectPath}
                        governanceStatus={sub.projectPath ? govHealth[sub.projectPath] : undefined}
                        onToggleProjectPin={sub.projectPath ? () => toggleProjectPin(sub.projectPath!) : undefined}
                        isProjectPinned={sub.projectPath ? pinnedProjects.has(sub.projectPath) : undefined}
                        onQuickCreate={sub.projectPath ? () => handleQuickCreate(sub.projectPath!) : undefined}
                        onOpenInFinder={
                          sub.projectPath && sub.projectPath !== 'default'
                            ? () => handleOpenInFinder(sub.projectPath!)
                            : undefined
                        }
                        onRenameProject={
                          sub.projectPath ? (name: string) => handleRenameProject(sub.projectPath!, name) : undefined
                        }
                        onArchiveThreads={sub.projectPath ? () => handleArchiveThreads(sub.projectPath!) : undefined}
                      >
                        {sub.threads.map((t) => (
                          <ThreadItem
                            key={t.id}
                            id={t.id}
                            title={t.title}
                            participants={t.participants}
                            lastActiveAt={t.lastActiveAt}
                            isActive={currentThreadId === t.id}
                            onSelect={handleSelect}
                            onDelete={handleDeleteRequest}
                            onRename={handleRename}
                            onTogglePin={handleTogglePin}
                            onToggleFavorite={handleToggleFavorite}
                            onUpdatePreferredCats={handleUpdatePreferredCats}
                            onUpdateLabels={handleUpdateLabels}
                            isPinned={t.pinned}
                            isFavorited={t.favorited}
                            threadState={getThreadState(t.id)}
                            projectPath={t.projectPath}
                            indented
                            preferredCats={t.preferredCats}
                            threadLabels={t.labels}
                            isHubThread={!!t.connectorHubState}
                          />
                        ))}
                      </SectionGroup>
                    );
                  })}
                </SectionGroup>
              );
            }

            return (
              <SectionGroup
                key={groupKey}
                label={group.projectPath ? (projectNames.get(group.projectPath) ?? group.label) : group.label}
                icon={icon}
                count={group.threads.length}
                isCollapsed={isCollapsed(groupKey)}
                onToggle={() => toggleGroup(groupKey)}
                projectPath={group.projectPath}
                governanceStatus={group.projectPath ? govHealth[group.projectPath] : undefined}
                onToggleProjectPin={
                  group.type === 'project' && group.projectPath ? () => toggleProjectPin(group.projectPath!) : undefined
                }
                isProjectPinned={
                  group.type === 'project' && group.projectPath ? pinnedProjects.has(group.projectPath) : undefined
                }
                onQuickCreate={
                  group.type === 'project' && group.projectPath
                    ? () => handleQuickCreate(group.projectPath!)
                    : undefined
                }
                // Note: system/pinned/recent/favorites groups get undefined for all project actions
                // because group.type !== 'project'. This is intentional — only project sections
                // should have Open in Finder / Rename / Archive / Quick Create.
                onOpenInFinder={
                  group.type === 'project' && group.projectPath && group.projectPath !== 'default'
                    ? () => handleOpenInFinder(group.projectPath!)
                    : undefined
                }
                onRenameProject={
                  group.type === 'project' && group.projectPath
                    ? (name: string) => handleRenameProject(group.projectPath!, name)
                    : undefined
                }
                onArchiveThreads={
                  group.type === 'project' && group.projectPath
                    ? () => handleArchiveThreads(group.projectPath!)
                    : undefined
                }
              >
                {group.threads.map((t) => (
                  <ThreadItem
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    participants={t.participants}
                    lastActiveAt={t.lastActiveAt}
                    isActive={currentThreadId === t.id}
                    onSelect={handleSelect}
                    onDelete={handleDeleteRequest}
                    onRename={handleRename}
                    onTogglePin={handleTogglePin}
                    onToggleFavorite={handleToggleFavorite}
                    onUpdatePreferredCats={handleUpdatePreferredCats}
                    onUpdateLabels={handleUpdateLabels}
                    isPinned={t.pinned}
                    isFavorited={t.favorited}
                    threadState={getThreadState(t.id)}
                    projectPath={t.projectPath}
                    indented={group.type === 'project'}
                    preferredCats={t.preferredCats}
                    threadLabels={t.labels}
                    isHubThread={!!t.connectorHubState}
                  />
                ))}
              </SectionGroup>
            );
          })}

          {normalizedQuery.length > 0 && threadGroups.length === 0 && !showDefaultThread && (
            <div className="px-3 py-4 text-xs text-cafe-muted">没有匹配的对话</div>
          )}
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
  thread: Thread;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isSystem = !!thread.connectorHubState;
  const title = thread.title ?? '未命名对话';
  const [typedName, setTypedName] = useState('');
  const confirmed = !isSystem || typedName === title;
  const confirmInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSystem) confirmInputRef.current?.focus();
  }, [isSystem]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-medium)]"
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
              这是系统级对话（IM Hub 连接器）。删除可能影响平台消息路由。
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
            className={`px-3 py-1.5 text-sm rounded-lg text-white transition-colors ${
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
