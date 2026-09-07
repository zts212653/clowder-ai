'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';

interface CloudBindingsResponse {
  bindings?: Record<string, string>;
}

type BindingState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'bound'; chatUrl: string; conversationId: string }
  | { kind: 'unauthorized' }
  | { kind: 'invalid' }
  | { kind: 'error' };

interface ThreadBindingState {
  threadId: string;
  value: BindingState;
}

const LOADING_BINDING: BindingState = { kind: 'loading' };

async function readCloudConversationBinding(threadId: string, signal: AbortSignal): Promise<BindingState | null> {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`, { signal });
  if (signal.aborted) return null;
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
  if (!response.ok) throw new Error(`Cloud conversation binding read failed (${response.status})`);

  const body = (await response.json()) as CloudBindingsResponse;
  if (signal.aborted) return null;
  const rawBinding = body.bindings?.['gpt-pro'];
  if (rawBinding === undefined) return { kind: 'empty' };

  const parsed = parseChatGptConversationUrl(rawBinding);
  return parsed ? { kind: 'bound', ...parsed } : { kind: 'invalid' };
}

function bindingStatus(binding: BindingState) {
  if (binding.kind === 'loading') return '读取中…';
  if (binding.kind === 'empty') return '未绑定';
  if (binding.kind === 'unauthorized') return '仅 thread owner 可见';
  if (binding.kind === 'invalid') return '绑定记录无效';
  if (binding.kind === 'error') return '暂时无法读取';
  return null;
}

export function CloudConversationLink({ threadId }: { threadId: string }) {
  const [threadBinding, setThreadBinding] = useState<ThreadBindingState>(() => ({
    threadId,
    value: LOADING_BINDING,
  }));
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyOperationRef = useRef(0);
  const currentThreadIdRef = useRef(threadId);
  const currentChatUrlRef = useRef<string | null>(null);
  const binding = threadBinding.threadId === threadId ? threadBinding.value : LOADING_BINDING;

  currentThreadIdRef.current = threadId;
  currentChatUrlRef.current = binding.kind === 'bound' ? binding.chatUrl : null;

  useEffect(() => {
    const controller = new AbortController();
    copyOperationRef.current += 1;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    setThreadBinding({ threadId, value: LOADING_BINDING });
    setCopyState('idle');

    void readCloudConversationBinding(threadId, controller.signal)
      .then((nextBinding) => {
        if (nextBinding && !controller.signal.aborted) setThreadBinding({ threadId, value: nextBinding });
      })
      .catch(() => {
        if (!controller.signal.aborted) setThreadBinding({ threadId, value: { kind: 'error' } });
      });

    return () => {
      controller.abort();
      copyOperationRef.current += 1;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    };
  }, [threadId]);

  const copyLink = useCallback(async () => {
    if (binding.kind !== 'bound') return;
    const operation = copyOperationRef.current + 1;
    copyOperationRef.current = operation;
    const operationThreadId = threadId;
    const operationChatUrl = binding.chatUrl;
    const isCurrentOperation = () =>
      copyOperationRef.current === operation &&
      currentThreadIdRef.current === operationThreadId &&
      currentChatUrlRef.current === operationChatUrl;

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;

    let nextCopyState: 'copied' | 'failed';
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(operationChatUrl);
      nextCopyState = 'copied';
    } catch {
      nextCopyState = 'failed';
    }

    if (!isCurrentOperation()) return;
    setCopyState(nextCopyState);
    copyTimerRef.current = setTimeout(() => {
      if (!isCurrentOperation()) return;
      copyTimerRef.current = null;
      setCopyState('idle');
    }, 1500);
  }, [binding, threadId]);

  const status = bindingStatus(binding);
  const settingsHref = '/settings?s=plugins#personal-chatgpt-pro';

  return (
    <div className="console-list-card mt-2 min-w-0 rounded-xl p-2.5" data-testid="cloud-conversation-link">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-xs font-semibold text-cafe">ChatGPT Conversation</span>
        <span className="shrink-0 rounded-full bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-micro font-medium text-cafe-secondary">
          云端砚砚
        </span>
      </div>
      <div className="mt-1 min-w-0 text-micro text-cafe-secondary">
        {binding.kind === 'bound' ? (
          <code className="block truncate font-mono" title={binding.chatUrl}>
            {binding.conversationId}
          </code>
        ) : (
          <span className="text-cafe-muted">{status}</span>
        )}
      </div>
      {binding.kind === 'bound' ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-micro" aria-live="polite">
          <button
            type="button"
            className="font-medium text-cafe-secondary transition-colors hover:text-cafe"
            aria-label="复制 ChatGPT 会话链接"
            onClick={() => void copyLink()}
          >
            {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制链接'}
          </button>
          <a
            className="font-medium text-cafe-secondary transition-colors hover:text-cafe"
            href={binding.chatUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在 ChatGPT 中打开当前会话"
          >
            打开会话
          </a>
          <a className="font-medium text-cafe-muted transition-colors hover:text-cafe" href={settingsHref}>
            更换绑定
          </a>
        </div>
      ) : binding.kind === 'empty' ? (
        <div className="mt-1.5 text-micro text-cafe-muted">
          <p>先在目标会话点击扩展的「授权此会话」，再为当前 thread 选择它。</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <a
              className="font-medium text-cafe-secondary transition-colors hover:text-cafe"
              href="https://chatgpt.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              打开 ChatGPT
            </a>
            <a className="font-medium text-cafe-secondary transition-colors hover:text-cafe" href={settingsHref}>
              去插件设置选会话
            </a>
          </div>
        </div>
      ) : binding.kind === 'invalid' || binding.kind === 'error' ? (
        <a
          className="mt-1.5 inline-block text-micro font-medium text-cafe-secondary transition-colors hover:text-cafe"
          href={settingsHref}
        >
          检查绑定
        </a>
      ) : null}
    </div>
  );
}
