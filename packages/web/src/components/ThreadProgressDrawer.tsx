'use client';

import type { ThreadProgressReceiptV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchThreadProgressPage, THREAD_BRIEF_INVALIDATED_EVENT } from '@/hooks/useThreadBrief';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { ContextualWorkspaceChrome } from './workspace/ContextualWorkspaceChrome';

interface ThreadProgressDrawerProps {
  readonly open: boolean;
  readonly docked: boolean;
  readonly threadId: string;
  readonly onClose: () => void;
  readonly returnFocusTo?: HTMLElement | null;
  readonly runDetails?: ReactNode;
}

export function ThreadProgressDrawer({
  open,
  docked,
  threadId,
  onClose,
  returnFocusTo,
  runDetails,
}: ThreadProgressDrawerProps) {
  const [tab, setTab] = useState<'progress' | 'runtime'>('progress');
  const [items, setItems] = useState<readonly ThreadProgressReceiptV1[]>([]);
  const [visibleCount, setVisibleCount] = useState(3);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pageAbortRef = useRef<AbortController | null>(null);
  const pageGenerationRef = useRef(0);
  const wasOpenRef = useRef(false);

  const loadFirstPage = useCallback(() => {
    pageAbortRef.current?.abort();
    const generation = pageGenerationRef.current + 1;
    pageGenerationRef.current = generation;
    const controller = new AbortController();
    pageAbortRef.current = controller;
    setLoading(true);
    setError(false);
    void fetchThreadProgressPage(threadId, undefined, controller.signal)
      .then((page) => {
        if (pageAbortRef.current !== controller || pageGenerationRef.current !== generation) return;
        setItems(page.items);
        setVisibleCount(3);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(true);
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          pageAbortRef.current === controller &&
          pageGenerationRef.current === generation
        ) {
          setLoading(false);
        }
      });
  }, [threadId]);

  const loadOlderPage = useCallback(
    async (cursor: string) => {
      pageAbortRef.current?.abort();
      const generation = pageGenerationRef.current;
      const controller = new AbortController();
      pageAbortRef.current = controller;
      setLoading(true);
      try {
        const page = await fetchThreadProgressPage(threadId, cursor, controller.signal);
        if (pageAbortRef.current !== controller || pageGenerationRef.current !== generation) return;
        setItems((current) => [...current, ...page.items]);
        setVisibleCount((current) => current + page.items.length);
        setNextCursor(page.nextCursor);
      } catch (cause: unknown) {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setError(true);
      } finally {
        if (pageAbortRef.current === controller && pageGenerationRef.current === generation) setLoading(false);
      }
    },
    [threadId],
  );

  useEffect(() => {
    if (!open) return;
    setTab('progress');
    loadFirstPage();
    const onInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId === threadId) loadFirstPage();
    };
    window.addEventListener(THREAD_BRIEF_INVALIDATED_EVENT, onInvalidated);
    return () => {
      pageGenerationRef.current += 1;
      pageAbortRef.current?.abort();
      pageAbortRef.current = null;
      window.removeEventListener(THREAD_BRIEF_INVALIDATED_EVENT, onInvalidated);
    };
  }, [loadFirstPage, open, threadId]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    queueMicrotask(() => returnFocusTo?.focus());
  }, [open, returnFocusTo]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.focus();
    const onKeyDown = (event: KeyboardEvent) => handleDrawerKeyDown(event, panel, onClose);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const loadMore = () => {
    if (visibleCount < items.length) {
      setVisibleCount(items.length);
      return;
    }
    if (nextCursor && !loading) void loadOlderPage(nextCursor);
  };

  return (
    <>
      {!docked && (
        <button
          type="button"
          tabIndex={-1}
          className="fixed inset-0 z-40 bg-[var(--console-overlay-backdrop)]"
          aria-label="关闭完整进展"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        />
      )}
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={
          docked
            ? 'flex h-full w-[420px] shrink-0 flex-col overflow-hidden'
            : 'fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden sm:w-[420px]'
        }
        aria-label="完整会话进展"
        data-testid="thread-progress-drawer"
        data-presentation={docked ? 'docked' : 'overlay'}
      >
        <ContextualWorkspaceChrome mode="progress" onFold={onClose}>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-cafe-subtle px-3">
              <TabButton active={tab === 'progress'} onClick={() => setTab('progress')}>
                进展
              </TabButton>
              <TabButton active={tab === 'runtime'} onClick={() => setTab('runtime')}>
                运行详情
              </TabButton>
            </div>
            {tab === 'runtime' ? (
              <div className="min-h-0 flex-1 overflow-y-auto">{runDetails}</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {loading && items.length === 0 && <p className="text-sm text-cafe-muted">正在读取关键进展…</p>}
                {error && items.length === 0 && <p className="text-sm text-cafe-muted">暂时无法读取进展</p>}
                {!loading && !error && items.length === 0 && (
                  <p className="text-sm text-cafe-muted">还没有关键进展记录</p>
                )}
                <ProgressTimeline items={items.slice(0, visibleCount)} threadId={threadId} onClose={onClose} />
                {(visibleCount < items.length || nextCursor) && (
                  <button
                    type="button"
                    className="mt-4 w-full rounded-lg border border-cafe-subtle py-2 text-xs text-cafe-secondary hover:bg-cafe-surface-sunken"
                    disabled={loading}
                    onClick={loadMore}
                  >
                    {loading ? '正在加载…' : visibleCount < items.length ? '展开本页更多' : '加载更早进展'}
                  </button>
                )}
              </div>
            )}
          </div>
        </ContextualWorkspaceChrome>
      </aside>
    </>
  );
}

function handleDrawerKeyDown(event: KeyboardEvent, panel: HTMLDivElement | null, onClose: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== 'Tab' || !panel) return;
  const focusable = Array.from(
    panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
  );
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`rounded-md px-3 py-1.5 text-xs font-medium ${active ? 'bg-cafe-surface-sunken text-cafe-black' : 'text-cafe-muted hover:text-cafe-secondary'}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ProgressTimeline({
  items,
  threadId,
  onClose,
}: {
  readonly items: readonly ThreadProgressReceiptV1[];
  readonly threadId: string;
  readonly onClose: () => void;
}) {
  let previousGroup = '';
  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const group = dateGroup(item.occurredAt);
        const showGroup = group !== previousGroup;
        previousGroup = group;
        return (
          <li key={item.id}>
            {showGroup && <h3 className="mb-2 mt-1 text-xs font-semibold text-cafe-muted">{group}</h3>}
            <article className="rounded-xl border border-cafe-subtle bg-cafe-surface/55 p-3">
              <p className="text-sm font-medium text-cafe-black">{item.headline}</p>
              {item.detail && <p className="mt-1 text-xs leading-5 text-cafe-secondary">{item.detail}</p>}
              {item.nextStep && (
                <p className="mt-2 text-xs text-cafe-secondary">
                  <span className="text-cafe-muted">下一步：</span>
                  {item.nextStep}
                </p>
              )}
              <EvidenceLink item={item} threadId={threadId} onClose={onClose} />
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceLink({
  item,
  threadId,
  onClose,
}: {
  item: ThreadProgressReceiptV1;
  threadId: string;
  onClose: () => void;
}) {
  const source = item.provenance[0];
  if (!source) return null;
  if (source.kind === 'invocation') return <p className="mt-2 text-xs text-cafe-muted">依据：本轮执行记录</p>;
  return (
    <button
      type="button"
      className="mt-2 text-xs font-medium text-cafe-accent hover:underline"
      onClick={() => void openSource(threadId, item, onClose)}
    >
      {source.kind === 'message' ? '查看相关消息' : '查看毛线球'}
    </button>
  );
}

async function openSource(threadId: string, receipt: ThreadProgressReceiptV1, onClose: () => void): Promise<void> {
  const response = await apiFetch(
    `/api/threads/${encodeURIComponent(threadId)}/progress/${encodeURIComponent(receipt.id)}/sources/0`,
  );
  if (!response.ok) return;
  const source = (await response.json()) as
    | { kind: 'message'; threadId: string; messageId: string }
    | { kind: 'task'; threadId: string; taskId: string }
    | { kind: 'invocation'; available: false };
  if (source.kind === 'message') {
    const plan = planTeleport({ threadId: source.threadId, messageId: source.messageId, currentThreadId: threadId });
    if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    } else if (plan.navigateTo) {
      pushThreadRouteWithHistory(plan.navigateTo, window);
    }
    onClose();
    return;
  }
  if (source.kind === 'task') {
    const store = useChatStore.getState();
    store.setWorkspaceMode('tasks');
    store.setRightPanelMode('workspace');
    onClose();
  }
}

function dateGroup(timestamp: number, now = new Date()): '今天' | '昨天' | '更早' {
  const date = new Date(timestamp);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  if (date.getTime() >= startToday) return '今天';
  if (date.getTime() >= startYesterday) return '昨天';
  return '更早';
}
