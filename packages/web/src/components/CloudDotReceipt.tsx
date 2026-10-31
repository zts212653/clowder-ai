'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useSettingsReadingEntry } from './shell/useSettingsSourceReturn';

interface DotDelivery {
  threadId: string;
  receivedAt: number | null;
  readAt: number | null;
  replyMessageId: string | null;
  stale: boolean;
}

export function CloudDotReceipt({ eventId }: { eventId?: string }) {
  const router = useRouter();
  const captureSettingsOrigin = useSettingsReadingEntry();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const [delivery, setDelivery] = useState<DotDelivery | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setDelivery(null);
    setUnavailable(false);
    if (!eventId || !/^dot_evt_[a-f0-9]{64}$/.test(eventId)) return;
    let active = true;
    const read = async () => {
      try {
        const response = await apiFetch(`/api/plugins/chatgpt-dot/delivery/${eventId}`);
        if (!response.ok) throw new Error('unavailable');
        const result = (await response.json()) as DotDelivery;
        if (active) {
          setDelivery(result);
          setUnavailable(false);
        }
      } catch {
        if (active) setUnavailable(true);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [eventId]);
  const threadId = delivery?.threadId ?? currentThreadId;
  const recoveryPath = `/settings?s=plugins${threadId ? `&from=${encodeURIComponent(threadId)}` : ''}#chatgpt-dot`;
  return (
    <section className="mt-2 space-y-1 text-xs text-cafe-muted" aria-label="dot 召唤回执">
      <p>
        {unavailable
          ? '暂时无法核对回程；保留最后确认状态。'
          : delivery?.replyMessageId
            ? 'dot 已回到原处'
            : delivery?.readAt
              ? 'dot 已读原消息，等待回复'
              : delivery?.receivedAt
                ? '召唤已收件，等待 dot 读取'
                : '尚未确认 dot 收件'}
      </p>
      {delivery?.stale && <p>这是旧连接的回执；恢复连接不会自动重派。</p>}
      <a
        className="underline"
        href={recoveryPath}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          captureSettingsOrigin();
          router.push(recoveryPath);
        }}
      >
        查看 dot 连接 ›
      </a>
    </section>
  );
}
