'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';
import type { PersonalChromeAuthorizedConversation } from './PersonalChromeAuthorizationList';
import { PersonalChromeThreadRouteOptions } from './PersonalChromeThreadRouteOptions';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsText } from './primitives/SettingsText';

type BindingLoadState = 'loading' | 'ready' | 'unsupported' | 'forbidden' | 'error';

interface CloudBindingsResponse {
  bindings?: Record<string, string>;
  error?: string;
}

interface PersonalChromeThreadBindingProps {
  conversations: readonly PersonalChromeAuthorizedConversation[];
  disabled: boolean;
}

export function PersonalChromeThreadBinding(props: PersonalChromeThreadBindingProps) {
  return (
    <Suspense fallback={<SettingsText tone="muted">正在读取当前 thread 路由…</SettingsText>}>
      <ThreadBindingTarget {...props} />
    </Suspense>
  );
}

function ThreadBindingTarget(props: PersonalChromeThreadBindingProps) {
  const searchParams = useSearchParams();
  const activeThreadId = useChatStore((store) => store.currentThreadId);
  const explicitThreadIds = searchParams?.getAll('threadId') ?? [];
  const threadId =
    explicitThreadIds.length === 0 ? activeThreadId : explicitThreadIds.length === 1 ? explicitThreadIds[0] : '';
  const threadTitle = useChatStore((store) => store.threads.find((thread) => thread.id === threadId)?.title);

  // A target change owns fresh pending/read/save state; prior responses cannot repaint it.
  return <ThreadBindingState key={threadId} {...props} threadId={threadId} threadTitle={threadTitle ?? undefined} />;
}

function ThreadBindingState({
  conversations,
  disabled,
  threadId: currentThreadId,
  threadTitle: currentThreadTitle,
}: PersonalChromeThreadBindingProps & {
  threadId: string;
  threadTitle?: string;
}) {
  const [loadState, setLoadState] = useState<BindingLoadState>('loading');
  const [bindingUrl, setBindingUrl] = useState<string | null>(null);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBinding = useCallback(
    async (signal?: AbortSignal) => {
      setLoadState('loading');
      setError(null);
      if (!currentThreadId.trim()) throw new Error('未指定有效的 thread，请从原对话重新打开“更换绑定”。');
      const response = await apiFetch(`/api/threads/${encodeURIComponent(currentThreadId)}/cloud-bindings`, {
        signal,
      });
      if (signal?.aborted) return;
      if (response.status === 403) {
        setBindingUrl(null);
        setLoadState(currentThreadId === 'default' ? 'unsupported' : 'forbidden');
        return;
      }
      const body = (await response.json().catch(() => ({}))) as CloudBindingsResponse;
      if (signal?.aborted) return;
      if (!response.ok) {
        throw new Error(body.error ?? `当前 thread 路由读取失败 (${response.status})`);
      }
      setBindingUrl(body.bindings?.['gpt-pro'] ?? null);
      setLoadState('ready');
    },
    [currentThreadId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadBinding(controller.signal).catch((cause) => {
      if (controller.signal.aborted) return;
      setLoadState('error');
      setError(cause instanceof Error ? cause.message : '当前 thread 路由读取失败');
    });
    return () => controller.abort();
  }, [loadBinding]);

  const updateBinding = useCallback(
    async (conversationId: string | null) => {
      setBusyConversationId(conversationId ?? 'clear');
      setError(null);
      try {
        const chatUrl = conversationId ? `https://chatgpt.com/c/${conversationId}` : null;
        const response = await apiFetch(`/api/threads/${encodeURIComponent(currentThreadId)}/cloud-bindings`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ catId: 'gpt-pro', chatUrl }),
        });
        const body = (await response.json().catch(() => ({}))) as CloudBindingsResponse;
        if (!response.ok) throw new Error(body.error ?? `当前 thread 路由更新失败 (${response.status})`);
        setBindingUrl(body.bindings?.['gpt-pro'] ?? null);
        setLoadState('ready');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '当前 thread 路由更新失败');
      } finally {
        setBusyConversationId(null);
      }
    },
    [currentThreadId],
  );

  const boundConversationId = parseChatGptConversationUrl(bindingUrl)?.conversationId ?? null;
  const bindingIsAuthorized = conversations.some((conversation) => conversation.conversationId === boundConversationId);
  const threadLabel = currentThreadTitle?.trim() || currentThreadId;

  return (
    <section
      aria-label="当前 Clowder AI thread 路由"
      className="mt-3 rounded-lg border border-[var(--console-border-soft)] px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SettingsText as="p" tone="secondary" className="font-medium">
          当前 thread 路由
        </SettingsText>
        {loadState === 'ready' && (
          <SettingsBadge tone={bindingIsAuthorized ? 'emerald' : 'amber'}>
            {bindingIsAuthorized ? '已完成' : '还差一步'}
          </SettingsBadge>
        )}
      </div>
      <SettingsText as="p" tone="muted" className="mt-1 break-all">
        {threadLabel}
      </SettingsText>
      <SettingsText as="p" tone="secondary" className="mt-1">
        扩展里的授权决定 Chrome 允许哪些会话；这里决定这个 Clowder AI thread 精确发往哪一个。
      </SettingsText>

      {loadState === 'loading' && (
        <SettingsText as="p" tone="muted" className="mt-2">
          正在读取当前 thread 路由…
        </SettingsText>
      )}
      {loadState === 'unsupported' && (
        <SettingsText as="p" tone="amber" className="mt-2">
          当前是系统 thread，不支持个人云端猫路由。请先切换到你创建的 thread。
        </SettingsText>
      )}
      {loadState === 'forbidden' && (
        <SettingsText as="p" tone="amber" className="mt-2">
          无权修改这个 thread 的云端会话绑定。请从你拥有的对话重新打开设置。
        </SettingsText>
      )}
      {loadState === 'ready' && bindingUrl && (
        <div className="mt-2 rounded-md bg-conn-green-bg px-2.5 py-2">
          <SettingsText as="p" tone={bindingIsAuthorized ? 'secondary' : 'amber'}>
            当前 thread 已路由到 <code className="break-all font-mono">{boundConversationId ?? bindingUrl}</code>
            {!bindingIsAuthorized && '，但这个会话已不在 Host 授权集合中，请重新选择。'}
          </SettingsText>
        </div>
      )}
      {loadState === 'ready' && (
        <PersonalChromeThreadRouteOptions
          conversations={conversations}
          boundConversationId={boundConversationId}
          hasBinding={bindingUrl !== null}
          disabled={disabled}
          busyConversationId={busyConversationId}
          onSelect={(conversationId) => void updateBinding(conversationId)}
        />
      )}
      {error && (
        <SettingsText as="p" tone="red" className="mt-2">
          {error}
        </SettingsText>
      )}
    </section>
  );
}
