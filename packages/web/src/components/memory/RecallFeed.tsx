'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { groupRecallEvents, type RecallGroup, recallKind, recallReadCount } from '@/hooks/recall-feed-model';
import { useThreadRecall } from '@/hooks/useRecallEvents';
import { useChatStore } from '@/stores/chatStore';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { RecallReplyGroup } from './RecallReplyGroup';
import { REPLY_RECALL_OPEN_EVENT, type ReplyRecallTarget, readReplyRecallTarget } from './recall-navigation';

export { RecallCard } from './RecallRow';

type Filter = 'all' | 'pull' | 'push';

function useReplyRecallTarget(threadId: string | null, onTarget: () => void) {
  const [target, setTarget] = useState<ReplyRecallTarget | null>(() => {
    if (typeof window === 'undefined') return null;
    const fromUrl = readReplyRecallTarget(new URL(window.location.href));
    return fromUrl?.threadId === threadId ? fromUrl : null;
  });
  useEffect(() => {
    const fromUrl = typeof window === 'undefined' ? undefined : readReplyRecallTarget(new URL(window.location.href));
    setTarget(fromUrl?.threadId === threadId ? fromUrl : null);
    if (fromUrl?.threadId === threadId) onTarget();
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<ReplyRecallTarget>).detail;
      if (detail.threadId === threadId) {
        setTarget(detail);
        onTarget();
      }
    };
    window.addEventListener(REPLY_RECALL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(REPLY_RECALL_OPEN_EVENT, onOpen);
  }, [onTarget, threadId]);
  const clearTarget = useCallback(() => {
    setTarget(null);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('recallThread');
    url.searchParams.delete('recallInv');
    url.searchParams.delete('recallCat');
    window.history.replaceState(window.history.state, '', url);
  }, []);
  return { target, clearTarget };
}

function findTargetGroup(groups: readonly RecallGroup[], target: ReplyRecallTarget | null) {
  if (!target) return undefined;
  return groups.find(
    (group) => group.invocationId === target.invocationId && (!target.catId || group.catId === target.catId),
  );
}

export function RecallFeed() {
  const {
    events,
    messages,
    threadId,
    historyStatus,
    cuesFailed,
    cuesLoading,
    retainedHistory,
    hasOlderReplies,
    historyCount,
    findReply,
    retry,
  } = useThreadRecall();
  const [filter, setFilter] = useState<Filter>('all');
  const [locating, setLocating] = useState<string | null>(null);
  const [locateError, setLocateError] = useState(false);
  const resetFilter = useCallback(() => setFilter('all'), []);
  const { target, clearTarget } = useReplyRecallTarget(threadId, resetFilter);
  const lookup = useRef<AbortController | null>(null);
  useEffect(() => {
    setLocating(null);
    setLocateError(false);
    return () => {
      lookup.current?.abort();
      lookup.current = null;
    };
  }, [threadId]);
  const allGroups = groupRecallEvents(events, messages);
  const filteredGroups = groupRecallEvents(
    events.filter((event) => filter === 'all' || (recallKind(event) === 'delivery') === (filter === 'push')),
    messages,
  );
  const groups = target ? allGroups : filteredGroups;
  const retrievals = events.filter((event) => recallKind(event) !== 'delivery');
  const deliveryCount = events.length - retrievals.length;
  const partial = historyStatus === 'error' && events.length > 0;
  const loading = historyStatus === 'loading' || cuesLoading;
  const targetGroup = findTargetGroup(allGroups, target);
  const locate = async (group: RecallGroup) => {
    if (!threadId) return;
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setLocating(group.id);
    setLocateError(false);
    try {
      const messageId = group.messageId ?? (await findReply(group.events[0], controller.signal));
      if (controller.signal.aborted || useChatStore.getState().currentThreadId !== threadId) return;
      if (!messageId) {
        setLocateError(true);
        return;
      }
      if (window.matchMedia('(max-width: 767px)').matches) useChatStore.getState().setRightPanelOpen(false);
      planTeleport({ threadId, messageId, currentThreadId: threadId });
      kickTeleportResolve();
    } catch {
      if (!controller.signal.aborted) setLocateError(true);
    } finally {
      if (lookup.current === controller) setLocating(null);
    }
  };
  return (
    <div data-testid="recall-feed" className="min-w-0 space-y-4 p-4 text-cafe-black">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-medium">这条对话里猫用到的记忆</h2>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-cafe-secondary">
            <span className="h-2 w-2 rounded-full bg-[var(--semantic-success)]" />
            实时
          </span>
        </div>
        {events.length > 0 && (
          <p className="text-compact text-cafe-secondary">
            {historyCount === 100 && '最近 100 次召回里：'}
            <span className="whitespace-nowrap">猫检索 {retrievals.length} 次</span>，其中{' '}
            <span className="whitespace-nowrap">
              {retrievals.filter((event) => recallReadCount(event) > 0).length} 次之后读了结果
            </span>
            {' · '}
            <span className="whitespace-nowrap">系统递送 {deliveryCount} 条</span>
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="召回类型" className="flex rounded-lg bg-cafe-surface p-1">
            {(
              [
                ['all', '全部'],
                ['pull', '猫的检索'],
                ['push', '系统递送'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => {
                  clearTarget();
                  setFilter(value);
                }}
                className={`rounded-md px-2 py-1.5 text-compact ${filter === value ? 'bg-cafe-surface-canvas text-cafe-black' : 'text-cafe-secondary hover:text-cafe-black'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Link
            href={`/memory${threadId ? `?from=${encodeURIComponent(threadId)}` : ''}`}
            className="text-compact text-cafe-accent hover:underline"
          >
            在记忆页打开
          </Link>
        </div>
      </header>
      {loading && (
        <p role="status" className="text-compact text-cafe-secondary">
          正在读取记忆记录…
        </p>
      )}
      {partial && (
        <div
          role="status"
          className="rounded-md border border-cafe-border-subtle bg-cafe-surface p-3 text-compact text-cafe-secondary"
        >
          {retainedHistory ? '历史记录更新失败，保留上次读到的记录。' : '只读到实时记录，历史记录暂时无法读取。'}
          <button type="button" onClick={retry} className="ml-2 text-cafe-accent hover:underline">
            重试
          </button>
        </div>
      )}
      {cuesFailed && (
        <p role="status" className="text-compact text-cafe-secondary">
          点名递送记录暂时无法读取。
          <button type="button" onClick={retry} className="ml-2 text-cafe-accent hover:underline">
            重试
          </button>
        </p>
      )}
      {historyStatus === 'error' && !events.length && (
        <div role="alert" className="rounded-lg border border-cafe-border-subtle bg-cafe-surface p-4 text-compact">
          <p>记忆记录读取失败。</p>
          <button type="button" onClick={retry} className="mt-2 text-cafe-accent hover:underline">
            重新读取
          </button>
        </div>
      )}
      {!loading && historyStatus === 'ready' && !cuesFailed && !events.length && (
        <p className="py-8 text-compact text-cafe-secondary">
          这条对话还没有召回记录。猫检索记忆或收到系统递送后，会显示在这里。
        </p>
      )}
      {events.length > 0 && !groups.length && <p className="py-4 text-compact text-cafe-secondary">没有这一类记录。</p>}
      {locateError && (
        <p role="alert" className="text-compact text-cafe-secondary">
          暂时无法定位这条回复。可以重试。
        </p>
      )}
      {target && !loading && !targetGroup && (
        <p role="status" data-testid="recall-target-missing" className="text-compact text-cafe-secondary">
          没找到这一轮的召回记录。
        </p>
      )}
      <div className="space-y-2">
        {groups.map((group, index) => (
          <RecallReplyGroup
            key={`${threadId}:${group.id}`}
            group={group}
            initiallyExpanded={target ? targetGroup?.id === group.id : index === 0}
            targeted={targetGroup?.id === group.id}
            locating={locating === group.id}
            earlierRepliesPending={hasOlderReplies || historyStatus === 'loading'}
            onLocate={locate}
          />
        ))}
      </div>
      {events.length > 0 && (
        <p className="text-xs text-cafe-secondary">
          “之后读了”是同一只猫、同一次调用中的后续读取观察；在 20 次工具调用以内或 5
          分钟以内均计入，两个都超出才停止观察。
        </p>
      )}
    </div>
  );
}
