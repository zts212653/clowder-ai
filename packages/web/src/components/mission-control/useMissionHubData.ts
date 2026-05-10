'use client';

import type { BacklogItem, CatId, ExternalProject, MissionHubSelfClaimScope, ThreadPhase } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getThreadHref } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { useMissionControlStore } from '@/stores/missionControlStore';
import { apiFetch } from '@/utils/api-client';
import * as ba from './backlog-actions';
import { extractFeatureId } from './FeatureBirdEyePanel';

interface ThreadSituationSummary {
  id: string;
  title?: string;
  lastActiveAt: number;
  participants: CatId[];
  backlogItemId?: string;
}

export type RightPanelTab = 'suggestion' | 'sop' | 'threads';

export function useMissionHubData() {
  const seqRef = useRef(0);
  const [selfClaimScopes, setSelfClaimScopes] = useState<Record<string, MissionHubSelfClaimScope>>({});
  const [selfClaimPolicyBlocker, setSelfClaimPolicyBlocker] = useState<ReturnType<typeof ba.detectBlocker>>(null);
  const [threadsByBacklogId, setThreadsByBacklogId] = useState<Record<string, ThreadSituationSummary>>({});
  const [threadCountByFeature, setThreadCountByFeature] = useState<Record<string, number>>({});
  const [threadsByFeatureId, setThreadsByFeatureId] = useState<Record<string, ThreadSituationSummary[]>>({});
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('suggestion');
  const [activeTab, setActiveTab] = useState<string>('features');
  const [showImportModal, setShowImportModal] = useState(false);

  const {
    items,
    loading,
    submitting,
    selectedItemId,
    selectedPhase,
    error,
    setItems,
    setLoading,
    setSubmitting,
    setSelectedItemId,
    setSelectedPhase,
    setError,
  } = useMissionControlStore();

  const { projects, setProjects, setActiveProjectId } = useExternalProjectStore();
  const storeThreadId = useChatStore((s) => s.currentThreadId);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/backlog/items');
      if (!res.ok) throw new Error(await ba.parseError(res));
      const body = (await res.json()) as { items?: BacklogItem[] };
      setItems(body.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载 backlog 失败');
    } finally {
      setLoading(false);
    }
  }, [setError, setItems, setLoading]);

  const loadSelfClaimScopes = useCallback(async () => {
    try {
      const res = await apiFetch('/api/backlog/self-claim-policy');
      if (!res.ok) throw new Error(await ba.parseError(res));
      const body = (await res.json()) as { scopes?: Record<string, MissionHubSelfClaimScope> };
      setSelfClaimScopes(body.scopes ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载 self-claim policy 失败');
    }
  }, [setError]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);
  useEffect(() => {
    void loadSelfClaimScopes();
  }, [loadSelfClaimScopes]);

  useEffect(() => {
    if (items.length === 0) {
      if (selectedItemId) setSelectedItemId(null);
      return;
    }
    if (!selectedItemId || !items.some((it) => it.id === selectedItemId)) setSelectedItemId(items[0].id);
  }, [items, selectedItemId, setSelectedItemId]);

  const selectedItem = useMemo(() => items.find((it) => it.id === selectedItemId) ?? null, [items, selectedItemId]);
  const dispatchedItems = useMemo(() => items.filter((it) => it.status === 'dispatched'), [items]);
  const dispatchedBacklogIds = useMemo(() => dispatchedItems.map((it) => it.id), [dispatchedItems]);

  const uniqueFeatureIds = useMemo(() => {
    const ids = new Set<string>();
    for (const it of items) {
      const fid = extractFeatureId(it.tags);
      if (fid !== 'Untagged') ids.add(fid);
    }
    return [...ids];
  }, [items]);

  const loadThreadSituations = useCallback(async (ids: string[]) => {
    const seq = ++seqRef.current;
    if (ids.length === 0) {
      setThreadsByBacklogId({});
      setThreadsLoading(false);
      return;
    }
    setThreadsLoading(true);
    try {
      const res = await apiFetch(`/api/threads?backlogItemIds=${encodeURIComponent(ids.join(','))}`);
      if (!res.ok) throw new Error(await ba.parseError(res));
      const body = (await res.json()) as { threads?: ThreadSituationSummary[] };
      const idSet = new Set(ids);
      const next: Record<string, ThreadSituationSummary> = {};
      for (const t of body.threads ?? []) {
        if (t.backlogItemId && idSet.has(t.backlogItemId)) next[t.backlogItemId] = t;
      }
      if (seq === seqRef.current) setThreadsByBacklogId(next);
    } catch {
      if (seq === seqRef.current) setThreadsByBacklogId({});
    } finally {
      if (seq === seqRef.current) setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadThreadSituations(dispatchedBacklogIds);
  }, [dispatchedBacklogIds, loadThreadSituations]);

  useEffect(() => {
    if (uniqueFeatureIds.length === 0) {
      setThreadCountByFeature({});
      setThreadsByFeatureId({});
      return;
    }
    const ctrl = new AbortController();
    void (async () => {
      try {
        const counts: Record<string, number> = {};
        const threads: Record<string, ThreadSituationSummary[]> = {};
        for (let i = 0; i < uniqueFeatureIds.length; i += 50) {
          if (ctrl.signal.aborted) return;
          const chunk = uniqueFeatureIds.slice(i, i + 50);
          const res = await apiFetch(`/api/threads?featureIds=${encodeURIComponent(chunk.join(','))}`, {
            signal: ctrl.signal,
          });
          if (!res.ok || ctrl.signal.aborted) return;
          const body = (await res.json()) as { threadsByFeature?: Record<string, ThreadSituationSummary[]> };
          for (const [fid, ts] of Object.entries(body.threadsByFeature ?? {})) {
            counts[fid] = (counts[fid] ?? 0) + ts.length;
            threads[fid] = [...(threads[fid] ?? []), ...ts];
          }
        }
        if (!ctrl.signal.aborted) {
          setThreadCountByFeature(counts);
          setThreadsByFeatureId(threads);
        }
      } catch {
        /* abort/network */
      }
    })();
    return () => ctrl.abort();
  }, [uniqueFeatureIds]);

  const withGuard = useCallback(
    async (task: () => Promise<void>) => {
      setSubmitting(true);
      setSelfClaimPolicyBlocker(null);
      setError(null);
      try {
        await task();
      } catch (e) {
        const raw = e instanceof Error ? e.message : '请求失败';
        setSelfClaimPolicyBlocker(ba.detectBlocker(raw));
        setError(ba.formatError(raw));
      } finally {
        setSubmitting(false);
      }
    },
    [setError, setSubmitting],
  );

  const handleCreate = useCallback(
    async (p: { title: string; summary: string; priority: BacklogItem['priority']; tags: string[] }) =>
      withGuard(async () => {
        const c = await ba.createBacklogItem(p);
        setSelectedItemId(c.id);
        await loadItems();
      }),
    [loadItems, setSelectedItemId, withGuard],
  );
  const handleDelete = useCallback(
    async (itemId: string) =>
      withGuard(async () => {
        await ba.deleteItem(itemId);
        if (selectedItemId === itemId) setSelectedItemId(null);
        await loadItems();
      }),
    [loadItems, selectedItemId, setSelectedItemId, withGuard],
  );
  const handleSuggest = useCallback(
    async (p: { itemId: string; catId: string; why: string; plan: string; requestedPhase: ThreadPhase }) =>
      withGuard(async () => {
        await ba.suggestClaim(p);
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleApprove = useCallback(
    async (p: { itemId: string; threadPhase: ThreadPhase }) =>
      withGuard(async () => {
        await ba.decideClaim(p.itemId, 'approve', { threadPhase: p.threadPhase });
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleReject = useCallback(
    async (p: { itemId: string; note?: string }) =>
      withGuard(async () => {
        await ba.decideClaim(p.itemId, 'reject', p.note ? { note: p.note } : {});
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleSelfClaim = useCallback(
    async (p: { itemId: string; catId: string; why: string; plan: string; requestedPhase: ThreadPhase }) =>
      withGuard(async () => {
        await ba.selfClaim(p);
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleAcquireLease = useCallback(
    async (p: { itemId: string; catId: string; ttlMs?: number }) =>
      withGuard(async () => {
        await ba.acquireLease(p);
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleHeartbeatLease = useCallback(
    async (p: { itemId: string; catId: string; ttlMs?: number }) =>
      withGuard(async () => {
        await ba.heartbeatLease(p);
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleReleaseLease = useCallback(
    async (p: { itemId: string; catId?: string }) =>
      withGuard(async () => {
        await ba.releaseLease(p);
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleReclaimLease = useCallback(
    async (p: { itemId: string }) =>
      withGuard(async () => {
        await ba.reclaimLease(p);
        await loadItems();
      }),
    [loadItems, withGuard],
  );
  const handleImportFromDocs = useCallback(
    async () =>
      withGuard(async () => {
        await ba.importActiveFeatures();
        await loadItems();
      }),
    [loadItems, withGuard],
  );

  const pendingCount = useMemo(
    () => items.filter((i) => i.status === 'suggested' || i.status === 'approved').length,
    [items],
  );
  const activeCount = useMemo(() => items.filter((i) => i.status === 'dispatched').length, [items]);
  const doneCount = useMemo(() => items.filter((i) => i.status === 'done').length, [items]);

  const loadExternalProjects = useCallback(async () => {
    try {
      const res = await apiFetch('/api/external-projects');
      if (res.ok) {
        const body = (await res.json()) as { projects: ExternalProject[] };
        setProjects(body.projects);
      }
    } catch {
      /* ignore */
    }
  }, [setProjects]);
  useEffect(() => {
    void loadExternalProjects();
  }, [loadExternalProjects]);

  const activeProject = useMemo(() => projects.find((p) => p.id === activeTab) ?? null, [projects, activeTab]);
  useEffect(() => {
    setActiveProjectId(activeProject?.id ?? null);
  }, [activeProject, setActiveProjectId]);

  const [fromParam] = useState(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('from') : null,
  );
  const referrerThread = useMemo(() => {
    if (fromParam) return fromParam;
    return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
  }, [fromParam, storeThreadId]);
  const backHref = getThreadHref(referrerThread ?? 'default');

  return {
    items,
    loading,
    submitting,
    selectedItemId,
    selectedItem,
    selectedPhase,
    error,
    selfClaimScopes,
    selfClaimPolicyBlocker,
    threadsByBacklogId,
    threadCountByFeature,
    threadsByFeatureId,
    threadsLoading,
    dispatchedItems,
    pendingCount,
    activeCount,
    doneCount,
    activeTab,
    rightPanelTab,
    showImportModal,
    projects,
    activeProject,
    backHref,
    setSelectedItemId,
    setSelectedPhase,
    setActiveTab,
    setRightPanelTab,
    setShowImportModal,
    handleCreate,
    handleDelete,
    handleSuggest,
    handleApprove,
    handleReject,
    handleSelfClaim,
    handleAcquireLease,
    handleHeartbeatLease,
    handleReleaseLease,
    handleReclaimLease,
    handleImportFromDocs,
  };
}
