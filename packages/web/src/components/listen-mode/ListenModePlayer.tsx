'use client';

import type { ListenPlaybackRate } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { documentListenController } from '@/services/DocumentListenController';
import { useChatStore } from '@/stores/chatStore';
import { listenDocumentCacheKey, useListenModeStore } from '@/stores/listenModeStore';
import { HubIcon } from '../hub-icons';
import { ListenCachePopover } from './ListenCachePopover';
import styles from './ListenModePlayer.module.css';

const PLAYBACK_RATES: ListenPlaybackRate[] = [0.75, 1, 1.25, 1.5, 2];

function statusText(phase: string, position: number): string {
  switch (phase) {
    case 'loading':
      return `正在准备第 ${position} 句`;
    case 'buffering':
      return `正在缓冲 · 第 ${position} 句`;
    case 'paused':
      return `已暂停 · 第 ${position} 句`;
    case 'error':
      return `第 ${position} 句生成失败`;
    case 'idle':
      return `已停在第 ${position} 句`;
    default:
      return `正在听 · 第 ${position} 句`;
  }
}

function TransportIcon({ kind }: { kind: 'play' | 'pause' | 'previous' | 'next' }) {
  if (kind === 'pause') {
    return (
      <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 12 14" fill="currentColor">
        <rect x="1" width="3" height="14" rx="0.5" />
        <rect x="8" width="3" height="14" rx="0.5" />
      </svg>
    );
  }
  if (kind === 'previous' || kind === 'next') {
    return (
      <svg
        aria-hidden="true"
        className="h-4 w-4"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={kind === 'previous' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'} />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 12 14" fill="currentColor">
      <path d="M1 1l10 6-10 6V1z" />
    </svg>
  );
}

interface ListenModePlayerProps {
  variant?: 'workspace' | 'mini';
  /** The full Workspace control is currently visible, so the fallback can stand down. */
  workspaceVisible?: boolean;
}

export function ListenModePlayer({ variant = 'workspace', workspaceVisible = false }: ListenModePlayerProps = {}) {
  const session = useListenModeStore((state) => state.session);
  const cacheByDocument = useListenModeStore((state) => state.cacheByDocument);
  const currentProjectPath = useChatStore((state) => state.currentProjectPath);
  const openFilePath = useChatStore((state) => state.workspaceOpenFilePath);
  const openWorktreeId = useChatStore((state) => state.workspaceWorktreeId);
  const workspaceSurface = useChatStore((state) => state.workspaceSurface);
  const rightPanelMode = useChatStore((state) => state.rightPanelMode);
  const [cacheOpen, setCacheOpen] = useState(false);
  const cacheRegionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cacheOpen) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!cacheRegionRef.current?.contains(event.target as Node)) setCacheOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    return () => document.removeEventListener('mousedown', closeOnOutsidePress);
  }, [cacheOpen]);

  if (!session) return null;
  const cache = cacheByDocument[listenDocumentCacheKey(session.identity)] ?? {
    cachedAnchors: session.cachedAnchors,
    cacheBytes: session.cacheBytes,
    totalSentences: session.sentences.length,
    active: false,
    error: null,
  };
  const currentSentence = session.sentences[session.currentIndex];
  const detailText = session.phase === 'error' ? session.error : currentSentence?.text;
  const currentPosition = session.currentIndex + 1;
  const progress = session.duration > 0 ? Math.min(100, (session.currentTime / session.duration) * 100) : 0;
  const away =
    currentProjectPath !== session.identity.projectPath ||
    openFilePath !== session.identity.relativePath ||
    openWorktreeId !== session.worktreeId ||
    workspaceSurface !== 'files' ||
    rightPanelMode !== 'workspace';
  const waiting = session.phase === 'loading' || session.phase === 'buffering';
  const paused = session.phase === 'paused' || session.phase === 'idle' || session.phase === 'error';

  const returnToDocument = () => {
    const store = useChatStore.getState();
    store.setCurrentProject(session.identity.projectPath);
    store.setWorkspaceOpenFile(session.identity.relativePath, null, session.worktreeId);
  };

  if (variant === 'mini') {
    if (workspaceVisible) return null;

    return (
      <aside
        data-testid="listen-mode-mini-player"
        aria-label="听读快捷控制"
        className="fixed bottom-24 right-4 z-30 flex max-w-[min(20rem,calc(100vw-2rem))] items-center gap-2 rounded-full border border-cafe bg-[var(--console-card-bg)] p-2 shadow-lg"
      >
        <button
          type="button"
          onClick={() => documentListenController.togglePlayback()}
          disabled={waiting}
          aria-label={waiting ? '缓冲中' : paused ? '播放' : '暂停'}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-conn-blue-text text-[var(--cafe-surface)] transition-colors hover:bg-conn-blue-hover disabled:cursor-wait disabled:opacity-50"
        >
          <TransportIcon kind={paused ? 'play' : 'pause'} />
        </button>
        <div className="min-w-0">
          <p className="truncate text-micro font-semibold text-cafe-secondary">
            {statusText(session.phase, currentPosition)}
          </p>
          <p className="truncate text-xs font-medium text-cafe">{session.title}</p>
        </div>
        <button
          type="button"
          onClick={returnToDocument}
          className="h-8 flex-shrink-0 whitespace-nowrap rounded-full border border-cafe px-2.5 text-xs font-semibold text-cafe-secondary hover:border-cafe-accent hover:text-cafe"
        >
          返回正文
        </button>
      </aside>
    );
  }

  return (
    <div
      data-testid="listen-mode-player"
      className={`${styles.container} relative z-20 mx-2 mt-2 flex-shrink-0 rounded-lg border border-cafe bg-cafe-surface-elevated shadow-sm`}
    >
      <div className={`${styles.layout} grid gap-2 px-3 py-2`}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => documentListenController.togglePlayback()}
            disabled={waiting}
            aria-label={waiting ? '缓冲中' : paused ? '播放' : '暂停'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-conn-blue-text text-[var(--cafe-surface)] transition-colors hover:bg-conn-blue-hover disabled:cursor-wait disabled:opacity-50"
          >
            <TransportIcon kind={paused ? 'play' : 'pause'} />
          </button>
          <button
            type="button"
            onClick={() => documentListenController.previous()}
            aria-label="上一句"
            className="flex h-7 w-7 items-center justify-center rounded-full text-lg text-cafe-secondary hover:bg-cafe-surface"
          >
            <TransportIcon kind="previous" />
          </button>
          <button
            type="button"
            onClick={() => documentListenController.next()}
            aria-label="下一句"
            className="flex h-7 w-7 items-center justify-center rounded-full text-lg text-cafe-secondary hover:bg-cafe-surface"
          >
            <TransportIcon kind="next" />
          </button>
        </div>
        <div className="min-w-0 self-center">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`flex-shrink-0 text-micro font-semibold ${session.phase === 'error' ? 'text-conn-red-text' : session.phase === 'buffering' ? 'text-conn-amber-text' : 'text-cafe-secondary'}`}
            >
              {statusText(session.phase, currentPosition)}
            </span>
            <span className="truncate text-micro text-cafe-muted">{session.title}</span>
          </div>
          <p className="truncate text-xs font-medium text-cafe" title={detailText ?? undefined}>
            {detailText}
          </p>
          <div
            role="progressbar"
            aria-label="当前句播放进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            className="mt-1 h-1 overflow-hidden rounded-full bg-cafe-surface"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${session.phase === 'error' ? 'bg-[var(--semantic-critical)]' : 'bg-[var(--semantic-info)]'}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <div className={`${styles.actions} flex min-w-0 flex-wrap items-center justify-end gap-1.5`}>
          {session.phase === 'error' ? (
            <button
              type="button"
              onClick={() => documentListenController.retry()}
              className="rounded-lg bg-cafe-accent px-2.5 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)]"
            >
              重试
            </button>
          ) : (
            <fieldset aria-label="播放速度" className="flex items-center rounded-full border border-cafe p-0.5">
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  aria-label={`${rate} 倍速`}
                  aria-pressed={session.playbackRate === rate}
                  onClick={() => documentListenController.setPlaybackRate(rate)}
                  className={`rounded-full px-1.5 py-1 text-micro font-semibold tabular-nums ${
                    session.playbackRate === rate
                      ? 'bg-cafe-accent text-[var(--cafe-accent-foreground)]'
                      : 'text-cafe-secondary hover:bg-cafe-surface'
                  }`}
                >
                  {rate}×
                </button>
              ))}
            </fieldset>
          )}
          {away && (
            <button
              type="button"
              onClick={returnToDocument}
              className="h-8 whitespace-nowrap rounded-lg border border-cafe px-2 text-xs font-semibold text-cafe-secondary hover:border-cafe-accent hover:text-cafe"
            >
              返回正文
            </button>
          )}
          <div ref={cacheRegionRef} className="relative">
            <button
              type="button"
              aria-expanded={cacheOpen}
              onClick={() => setCacheOpen((open) => !open)}
              className="h-8 whitespace-nowrap rounded-lg border border-cafe px-2 text-xs font-semibold text-cafe-secondary hover:border-cafe-accent hover:text-cafe"
            >
              缓存 {cache.cachedAnchors.length}/{cache.totalSentences}
            </button>
            {cacheOpen && <ListenCachePopover cache={cache} onClose={() => setCacheOpen(false)} session={session} />}
          </div>
          <button
            type="button"
            onClick={() => documentListenController.stop()}
            aria-label="关闭听读"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted hover:bg-cafe-surface"
          >
            <HubIcon name="x" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
