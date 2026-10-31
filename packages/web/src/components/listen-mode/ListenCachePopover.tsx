'use client';

import type { ListenRetention } from '@cat-cafe/shared';
import { useState } from 'react';
import { documentCacheController } from '@/services/DocumentCacheController';
import { documentListenController } from '@/services/DocumentListenController';
import type { ListenDocumentCacheProjection, ListenModeSession } from '@/stores/listenModeStore';
import { HubIcon } from '../hub-icons';

const RETENTION_OPTIONS: Array<{ value: ListenRetention; label: string; hint: string }> = [
  { value: '7d', label: '7 天', hint: '默认 · 按最近使用时间' },
  { value: '30d', label: '30 天', hint: '适合近期反复听' },
  { value: 'forever', label: '永久', hint: '除非你主动清理' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ListenCachePopoverProps {
  cache: Pick<ListenDocumentCacheProjection, 'active' | 'cacheBytes' | 'cachedAnchors' | 'error' | 'totalSentences'>;
  onClose: () => void;
  session: ListenModeSession;
}

export function ListenCachePopover({ cache, onClose, session }: ListenCachePopoverProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const cached = cache.cachedAnchors.length;
  const canResume = cached < cache.totalSentences;

  return (
    <aside
      role="dialog"
      aria-label="此文档缓存"
      className="absolute top-full right-0 z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-cafe bg-[var(--console-card-bg)] p-4 shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-cafe">此文档缓存</h3>
          <p className="mt-1 text-xs text-cafe-secondary">
            已缓存 {cached}/{cache.totalSentences} 句 · {formatBytes(cache.cacheBytes)}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭缓存设置" className="text-cafe-muted">
          <HubIcon name="x" className="h-4 w-4" />
        </button>
      </div>
      {cache.error && (
        <p className="mt-3 rounded-md bg-[var(--semantic-warning-surface)] px-2 py-1.5 text-xs text-conn-amber-text">
          {cache.error}
        </p>
      )}
      {(cache.active || canResume) && (
        <button
          type="button"
          onClick={() => {
            if (cache.active) {
              void documentCacheController.cancel(session).catch(() => undefined);
            } else {
              void documentCacheController.start(session).catch(() => undefined);
            }
          }}
          className="mt-3 flex w-full items-center justify-center rounded-lg border border-cafe-accent px-3 py-2 text-xs font-semibold text-cafe-accent hover:bg-cafe-surface"
        >
          {cache.active ? `取消缓存 ${cached}/${cache.totalSentences}` : `继续缓存 ${cached}/${cache.totalSentences}`}
        </button>
      )}
      <fieldset className="mt-4 space-y-2">
        <legend className="text-micro font-bold uppercase tracking-[0.12em] text-cafe-muted">保留音频</legend>
        {RETENTION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={session.retention === option.value}
            onClick={() => documentListenController.setRetention(option.value)}
            className={`mt-2 flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
              session.retention === option.value
                ? 'border-cafe-accent [background:color-mix(in_oklch,var(--cafe-accent)_10%,transparent)]'
                : 'border-cafe hover:bg-cafe-surface-elevated'
            }`}
          >
            <span className="text-xs font-semibold text-cafe">{option.label}</span>
            <span className="text-right text-micro text-cafe-muted">{option.hint}</span>
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        onClick={() => {
          if (!confirmClear) {
            setConfirmClear(true);
            return;
          }
          void documentCacheController
            .clearAudio(session)
            .then(() => {
              setConfirmClear(false);
              onClose();
            })
            .catch(() => undefined);
        }}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--semantic-critical)] bg-[var(--semantic-critical-surface)] px-3 py-2 text-xs font-semibold text-conn-red-text"
      >
        <HubIcon name="trash" className="h-4 w-4" />
        {confirmClear ? '确认清理此文档音频' : '清除此文档的音频'}
      </button>
      <p className="mt-2 text-micro leading-4 text-cafe-muted">不会删除原文、上次听到的位置或倍速设置。</p>
    </aside>
  );
}
