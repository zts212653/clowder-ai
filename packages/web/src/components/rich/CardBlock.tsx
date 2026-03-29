'use client';

import { useCallback, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

const TONE_STYLES: Record<string, string> = {
  info: 'border-l-blue-400 bg-blue-50 dark:bg-blue-950/30',
  success: 'border-l-green-400 bg-green-50 dark:bg-green-950/30',
  warning: 'border-l-yellow-400 bg-yellow-50 dark:bg-yellow-950/30',
  danger: 'border-l-red-400 bg-red-50 dark:bg-red-950/30',
};

export function CardBlock({ block, messageId }: { block: RichCardBlock; messageId?: string }) {
  const toneStyle = TONE_STYLES[block.tone ?? 'info'] ?? TONE_STYLES['info'];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAction = useCallback(
    async (action: string, payload?: Record<string, unknown>) => {
      if (action !== 'tts-resynthesize' || !messageId || !payload) return;

      setLoading(true);
      setError(null);

      try {
        const res = await apiFetch('/api/tts/resynthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: payload.text, catId: payload.catId }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }

        const data = (await res.json()) as { audioUrl: string; durationSec?: number };

        // Replace this card with an audio block
        useChatStore.getState().updateRichBlock(messageId, block.id, {
          kind: 'audio',
          title: undefined,
          bodyMarkdown: undefined,
          tone: undefined,
          fields: undefined,
          actions: undefined,
          url: data.audioUrl,
          text: payload.text as string,
          durationSec: data.durationSec,
          mimeType: 'audio/wav',
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : '重新合成失败');
      } finally {
        setLoading(false);
      }
    },
    [messageId, block.id],
  );

  return (
    <div className={`border-l-4 rounded-r-lg p-3 ${toneStyle}`}>
      <div className="font-medium text-sm">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-cafe-secondary dark:text-gray-300 [&_.markdown-content]:text-xs [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {block.fields && block.fields.length > 0 && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
          {block.fields.map((f, i) => (
            <div key={i} className="text-xs">
              <span className="text-cafe-secondary">{f.label}:</span>{' '}
              <span className="font-mono break-all">{f.value}</span>
            </div>
          ))}
        </div>
      )}
      {block.actions && block.actions.length > 0 && (
        <div className="mt-2 flex gap-2">
          {block.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              disabled={loading}
              onClick={() => handleAction(a.action, a.payload)}
              className="text-xs px-2 py-1 rounded bg-yellow-100 dark:bg-yellow-900/40 hover:bg-yellow-200 dark:hover:bg-yellow-800/50 text-yellow-800 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-700 disabled:opacity-50 transition-colors"
            >
              {loading ? '合成中...' : a.label}
            </button>
          ))}
        </div>
      )}
      {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
    </div>
  );
}
