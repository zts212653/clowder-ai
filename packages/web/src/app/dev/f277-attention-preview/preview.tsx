'use client';

import { useMemo, useRef, useState } from 'react';
import {
  type AttentionCluster,
  arrangeAttentionRows,
  buildAttentionClusters,
} from '@/components/ThreadSidebar/attention-clusters';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import {
  F277_INITIAL_THREAD_ID,
  F277_PREVIEW_CLUSTERS,
  F277_PREVIEW_GROUPS,
  type F277PreviewThread,
  previewClusterMatches,
} from './fixtures';
import { PreviewAttentionList } from './preview-attention-list';
import { applyPreviewGroupCommand, type PreviewGroupState } from './preview-group-state';
import { PreviewNavRail, PreviewSearchIcon } from './preview-nav-rail';
import { PreviewThreadRow } from './preview-thread-row';

const OPEN_PREF_KEY = 'cat-cafe:f277-preview:cluster-open';

function readPreference(key: string): Record<string, string | boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function F277AttentionPreview() {
  const [query, setQuery] = useState('');
  const [activeThreadId, setActiveThreadId] = useState(F277_INITIAL_THREAD_ID);
  const [threads, setThreads] = useState<F277PreviewThread[]>(() =>
    F277_PREVIEW_CLUSTERS.flatMap((cluster) => cluster.members.map((member) => ({ ...member }))),
  );
  const [groupState, setGroupState] = useState<PreviewGroupState>({
    groups: F277_PREVIEW_GROUPS.map((group) => ({ ...group, threadIds: [...group.threadIds] })),
  });
  const [arrangeMode, setArrangeMode] = useState(false);
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const draggedThreadIdRef = useRef<string | null>(null);
  const [organizerThreadId, setOrganizerThreadId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [openPreferences, setOpenPreferences] = useState<Record<string, boolean>>(() => {
    const stored = readPreference(OPEN_PREF_KEY);
    return Object.fromEntries(
      Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    );
  });
  const [mainDraft, setMainDraft] = useState('');

  const attentionClusters = useMemo(() => buildAttentionClusters(threads, groupState.groups), [groupState, threads]);
  const clusterByThreadId = useMemo(() => {
    const result = new Map<string, AttentionCluster>();
    for (const cluster of attentionClusters) {
      for (const memberId of cluster.memberIds) result.set(memberId, cluster);
    }
    return result;
  }, [attentionClusters]);
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
  const activeCluster = activeThread ? clusterByThreadId.get(activeThread.id) : undefined;
  const viewIdForCluster = (cluster: AttentionCluster) =>
    F277_PREVIEW_CLUSTERS.find((fixture) =>
      cluster.memberIds.some((memberId) => fixture.members.some((member) => member.id === memberId)),
    )?.id ?? cluster.anchor;
  const titleForCluster = (cluster: AttentionCluster) => cluster.title;
  const filteredThreads = useMemo(() => {
    if (!query.trim()) return threads;
    const normalized = query.trim().toLocaleLowerCase();
    const fixtureMatches = new Set(
      F277_PREVIEW_CLUSTERS.filter((fixture) => {
        const firstMemberId = fixture.members[0]?.id;
        const displayTitle = attentionClusters.find((cluster) =>
          cluster.memberIds.includes(firstMemberId ?? ''),
        )?.title;
        return previewClusterMatches(
          fixture,
          displayTitle ?? `${fixture.exactAnchor} · ${fixture.canonicalTitle}`,
          normalized,
        );
      }).map((fixture) => fixture.id),
    );
    return threads.filter((thread) => {
      if (`${thread.title ?? ''} ${thread.id}`.toLocaleLowerCase().includes(normalized)) return true;
      return F277_PREVIEW_CLUSTERS.some(
        (fixture) => fixtureMatches.has(fixture.id) && fixture.members.some((member) => member.id === thread.id),
      );
    });
  }, [attentionClusters, query, threads]);
  const attentionItems = useMemo(
    () => arrangeAttentionRows(filteredThreads, threads, attentionClusters, 'recent'),
    [attentionClusters, filteredThreads, threads],
  );
  const organizerThread = threads.find((thread) => thread.id === organizerThreadId);

  const toggleCluster = (viewId: string, expanded: boolean) => {
    const next = { ...openPreferences, [viewId]: !expanded };
    setOpenPreferences(next);
    window.localStorage.setItem(OPEN_PREF_KEY, JSON.stringify(next));
  };

  const renameCluster = (cluster: AttentionCluster, alias: string | null) => {
    setGroupState((state) =>
      applyPreviewGroupCommand(state, { action: 'rename', groupId: cluster.groupId, name: alias }),
    );
  };

  const updateThread = (threadId: string, update: (thread: F277PreviewThread) => F277PreviewThread) => {
    setThreads((current) => current.map((thread) => (thread.id === threadId ? update(thread) : thread)));
  };

  const mutateGroup = (command: Parameters<typeof applyPreviewGroupCommand>[1]) => {
    setGroupState((state) => applyPreviewGroupCommand(state, command));
    setActionNotice('对话组已更新；这是和生产相同的成员整理语义');
  };

  const dropThread = (sourceThreadId: string, targetThreadId: string) => {
    if (sourceThreadId === targetThreadId) return;
    const targetCluster = clusterByThreadId.get(targetThreadId);
    if (targetCluster) {
      mutateGroup({
        action: 'move',
        groupId: targetCluster.groupId,
        threadId: sourceThreadId,
        beforeThreadId: targetThreadId,
      });
      return;
    }
    mutateGroup({
      action: 'create',
      threadIds: [targetThreadId, sourceThreadId],
    });
  };

  const dropCluster = (sourceThreadId: string, cluster: AttentionCluster) => {
    if (cluster.memberIds.includes(sourceThreadId)) return;
    mutateGroup({ action: 'move', groupId: cluster.groupId, threadId: sourceThreadId });
  };

  const quoteToMain = () => {
    if (!activeThread) return;
    const excerpt = activeThread.previewMessage.slice(0, 72);
    const exactRef = `${activeThread.id}#${activeThread.previewMessageId}`;
    setMainDraft((draft) => `${draft}${draft ? '\n\n' : ''}[引用：${exactRef}]\n> ${excerpt}`);
  };

  const renderThread = (row: SidebarSnapshotRow) => {
    const thread = row as F277PreviewThread;
    return (
      <PreviewThreadRow
        thread={thread}
        activeThreadId={activeThreadId}
        arrangeMode={arrangeMode}
        draggedThreadId={draggedThreadId}
        onSelect={(threadId) => {
          setActiveThreadId(threadId);
          setActionNotice(null);
        }}
        onDelete={(threadId) => {
          const nextThreads = threads.filter((candidate) => candidate.id !== threadId);
          setThreads(nextThreads);
          if (activeThreadId === threadId && nextThreads[0]) setActiveThreadId(nextThreads[0].id);
          setActionNotice('对话已从这次验收数据中删除');
        }}
        onRename={(threadId, title) => {
          updateThread(threadId, (current) => ({ ...current, title }));
          setActionNotice('对话名称已更新');
        }}
        onTogglePin={(threadId, pinned) => updateThread(threadId, (current) => ({ ...current, pinned }))}
        onToggleFavorite={(threadId, favorited) => updateThread(threadId, (current) => ({ ...current, favorited }))}
        onUpdatePreferredCats={(threadId, preferredCats) =>
          updateThread(threadId, (current) => ({ ...current, preferredCats }))
        }
        onUpdateLabels={(threadId, labels) => updateThread(threadId, (current) => ({ ...current, labels }))}
        onOrganize={(threadId) => {
          setArrangeMode(true);
          setOrganizerThreadId(threadId);
        }}
        onReplay={(threadId) => {
          const replay = threads.find((candidate) => candidate.id === threadId);
          setActionNotice(`回放剧场 · ${replay?.title ?? '未命名对话'}`);
        }}
        onEnterArrange={() => setArrangeMode(true)}
        onDragStartThread={(threadId) => {
          draggedThreadIdRef.current = threadId;
          setDraggedThreadId(threadId);
        }}
        onDragEndThread={() => {
          draggedThreadIdRef.current = null;
          setDraggedThreadId(null);
        }}
        getDraggedThreadId={() => draggedThreadIdRef.current}
        onDropThread={dropThread}
      />
    );
  };

  return (
    <main
      className="h-screen overflow-hidden bg-[var(--console-shell-bg)] text-cafe"
      data-testid="f277-real-shell-preview"
    >
      <div className="flex h-full">
        <PreviewNavRail />

        <aside className="relative flex w-[390px] shrink-0 flex-col border-r border-cafe bg-[var(--console-panel-bg)]">
          <header className="space-y-3 border-b border-cafe px-4 pb-3 pt-4">
            <div className="flex items-center justify-between">
              <h1 className="text-base font-bold text-cafe-black">对话</h1>
            </div>
            <label className="flex items-center gap-2 rounded-xl border border-cafe bg-[var(--console-field-bg)] px-3 py-2 text-cafe-muted focus-within:border-cafe-accent">
              <PreviewSearchIcon />
              <input
                aria-label="搜索对话"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索对话"
                className="min-w-0 flex-1 bg-transparent text-sm text-cafe-black outline-none placeholder:text-cafe-muted"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} className="text-micro text-cafe-secondary">
                  清除
                </button>
              )}
            </label>
            <div className="flex items-center gap-4 text-xs font-medium text-cafe-muted">
              <span>置顶</span>
              <span className="border-b-2 border-cafe-accent pb-2 text-cafe-accent">最近</span>
              <span>项目</span>
              <span>收藏</span>
            </div>
          </header>

          <PreviewAttentionList
            items={attentionItems}
            query={query}
            openPreferences={openPreferences}
            activeClusterAnchor={activeCluster?.anchor}
            arrangeMode={arrangeMode}
            draggedThreadId={draggedThreadId}
            clusterByThreadId={clusterByThreadId}
            organizerThread={organizerThread}
            threads={threads}
            groupState={groupState}
            viewIdForCluster={viewIdForCluster}
            titleForCluster={titleForCluster}
            renderThread={renderThread}
            onToggleCluster={toggleCluster}
            onRenameCluster={renameCluster}
            onDropCluster={dropCluster}
            onMutateGroup={mutateGroup}
            onSetArrangeMode={setArrangeMode}
            onSetDraggedThreadId={setDraggedThreadId}
            onCloseOrganizer={() => setOrganizerThreadId(null)}
          />
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[var(--console-card-bg)]">
          <header className="border-b border-cafe px-6 py-4">
            <p className="text-micro font-semibold uppercase tracking-[0.12em] text-cafe-muted">当前对话</p>
            <h2 className="mt-1 line-clamp-1 text-base font-bold text-cafe-black">{activeThread?.title}</h2>
            {actionNotice && (
              <p className="mt-1 text-xs text-cafe-accent" role="status">
                {actionNotice}
              </p>
            )}
          </header>
          <div className="flex-1 overflow-y-auto px-6 py-8">
            <div className="mx-auto max-w-2xl space-y-5">
              <div className="rounded-2xl border border-cafe bg-[var(--console-panel-bg)] p-5 shadow-[var(--console-shadow-soft)]">
                <div className="mb-3 flex items-center justify-between gap-3 text-xs text-cafe-muted">
                  <span className="font-semibold text-cafe-secondary">缅因猫 Sol</span>
                  <span>原消息</span>
                </div>
                <p className="text-sm leading-7 text-cafe-black">{activeThread?.previewMessage}</p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    data-quote-to-main
                    onClick={quoteToMain}
                    className="rounded-lg border border-cafe px-3 py-1.5 text-xs font-semibold text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
                  >
                    引用到主对话草稿
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-cafe bg-[var(--console-panel-bg)] p-4">
            <div className="mx-auto max-w-2xl">
              <label htmlFor="f277-main-draft" className="mb-2 block text-micro font-semibold text-cafe-muted">
                主对话草稿 · 带来源，可回到原消息
              </label>
              <textarea
                id="f277-main-draft"
                data-testid="main-draft"
                value={mainDraft}
                onChange={(event) => setMainDraft(event.target.value)}
                placeholder="输入消息…"
                rows={4}
                className="w-full resize-none rounded-2xl border border-cafe bg-[var(--console-field-bg)] px-4 py-3 text-sm leading-6 outline-none focus:border-cafe-accent"
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
