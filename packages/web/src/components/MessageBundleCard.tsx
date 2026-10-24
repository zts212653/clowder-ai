'use client';

import {
  type MessageSelectionProjectedItem as BundleItem,
  type HydratedMessageBundle,
  isHydratedMessageBundle,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { HubIcon } from './hub-icons';
import { MessageBundleItemView } from './MessageBundleItemView';
import { messageBundleSenderLabel } from './message-bundle-sender';
import { MessageBundlePaperCard } from './message-v2/MessageBundlePaperCard';
import { useShellPresentation } from './shell/shell-presentation';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

interface MessageBundleCardProps {
  messageId: string;
  forwarderName: string;
  getCatLabel: (catId: string) => string;
}

export function MessageBundleCard(props: MessageBundleCardProps) {
  // A different carrier starts a different read, including its fold and error state.
  return <MessageBundleRead key={props.messageId} {...props} />;
}

function MessageBundleRead({ messageId, forwarderName, getCatLabel }: MessageBundleCardProps) {
  const presentation = useShellPresentation();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const [data, setData] = useState<HydratedMessageBundle | null>(null);
  const [error, setError] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void apiFetch(
      `/api/message-bundles/${encodeURIComponent(messageId)}`,
      { signal: controller.signal },
      { afterCurrentGet: requestVersion > 0 },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Message Bundle hydration failed (${response.status})`);
        const body: unknown = await response.json();
        if (!isHydratedMessageBundle(body) || body.messageBundleId !== messageId) {
          throw new Error('Invalid Message Bundle response');
        }
        if (!controller.signal.aborted) setData(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(true);
        }
      });
    return () => controller.abort();
  }, [messageId, requestVersion]);

  const reload = () => {
    setData(null);
    setError(false);
    setRequestVersion((version) => version + 1);
  };
  const toggle = () => {
    setExpanded(!expanded);
    // Both presentations reauthorize before revealing the full source.
    if (!expanded) reload();
  };

  const jumpToSource = useCallback(
    (threadId: string, sourceMessageId?: string) => {
      if (!sourceMessageId) {
        pushThreadRouteWithHistory(threadId, typeof window === 'undefined' ? undefined : window);
        return;
      }
      const plan = planTeleport({ threadId, messageId: sourceMessageId, currentThreadId });
      if (plan.scrollNow) {
        scrollToMessage(plan.scrollNow);
        kickTeleportResolve();
      } else if (plan.navigateTo) {
        pushThreadRouteWithHistory(plan.navigateTo, typeof window === 'undefined' ? undefined : window);
      }
    },
    [currentThreadId],
  );

  if (presentation === 'v2')
    return (
      <MessageBundlePaperCard
        messageId={messageId}
        data={data}
        error={error}
        expanded={expanded}
        forwarderName={forwarderName}
        getCatLabel={getCatLabel}
        onJump={jumpToSource}
        onRetry={reload}
        onToggle={toggle}
      />
    );

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-semantic-danger/40 bg-cafe-surface-sunken p-3 text-sm">
        <div className="font-medium text-cafe-secondary">转发内容暂时无法读取</div>
        <button
          type="button"
          className="mt-2 rounded-md border border-cafe px-2 py-1 text-xs text-cafe-interactive hover:bg-cafe-surface"
          onClick={reload}
        >
          重试
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <output className="block rounded-xl border border-cafe bg-cafe-surface-sunken p-3 text-sm text-cafe-muted">
        正在读取转发内容…
      </output>
    );
  }

  const availableItems = data.items.filter((item) => item.status === 'available');
  const singleItem = data.items.length === 1 ? data.items[0] : undefined;
  const messageCount = new Set(data.items.map((item) => item.messageId)).size;
  const participants = [
    ...new Set(
      availableItems.map((item) => messageBundleSenderLabel(item.from, data.createdBy, forwarderName, getCatLabel)),
    ),
  ];
  const sourceTitle = data.sourceThread?.title ?? '来源不可用';
  const sourceThreadId = data.sourceThread?.id;

  const renderItem = (item: BundleItem, index: number) => (
    <div
      key={`${item.messageId}:${item.status === 'available' ? item.kind : item.reason}:${index}`}
      className="border-t border-cafe/70 pt-3 first:border-t-0 first:pt-0"
    >
      <MessageBundleItemView
        item={item}
        index={index}
        createdBy={data.createdBy}
        forwarderName={forwarderName}
        getCatLabel={getCatLabel}
        onJump={jumpToSource}
      />
    </div>
  );

  return (
    <section
      data-message-bundle-id={messageId}
      className="min-w-0 rounded-xl border border-cafe bg-cafe-surface p-3 shadow-sm"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <button
          type="button"
          disabled={!sourceThreadId}
          onClick={() => sourceThreadId && jumpToSource(sourceThreadId)}
          className="flex min-w-0 items-center gap-1 text-left text-xs font-semibold text-cafe-interactive disabled:cursor-default disabled:text-cafe-muted"
        >
          <span className="truncate">来自「{sourceTitle}」</span>
          <HubIcon name="external-link" className="h-3 w-3 shrink-0" />
        </button>
        {!singleItem ? <span className="shrink-0 text-xs text-cafe-muted">{messageCount} 条聊天记录</span> : null}
      </div>
      {data.note ? (
        <div data-message-bundle-note className="mt-3 rounded-lg bg-cafe-surface-sunken px-3 py-2 text-sm">
          <div className="text-xs font-semibold text-cafe-secondary">{forwarderName} 的留言</div>
          <div className="mt-1 whitespace-pre-wrap break-words text-cafe-primary">{data.note}</div>
        </div>
      ) : null}
      {singleItem ? (
        <div className="mt-3">{renderItem(singleItem, 0)}</div>
      ) : (
        <>
          <div className="mt-2 text-xs text-cafe-muted">
            由 {forwarderName} 转发
            {participants.length ? ` · ${participants.join(' · ')}` : ' · 原消息不可用'}
          </div>
          <button
            type="button"
            className="mt-3 w-full rounded-lg border border-cafe px-3 py-2 text-left text-sm font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
            aria-expanded={expanded}
            onClick={toggle}
          >
            {expanded ? '收起聊天记录' : `展开 ${messageCount} 条聊天记录`}
          </button>
          {expanded ? <div className="mt-3 space-y-3">{data.items.map(renderItem)}</div> : null}
        </>
      )}
    </section>
  );
}
