'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import { type ListenSentence, maskLeadingMarkdownFrontmatter } from '@/lib/listen-mode/markdown-sentences';
import { HubIcon } from '../hub-icons';
import { LiveSelectionAnnotationAction } from '../LiveSelectionAnnotationAction';
import { MarkdownContent } from '../MarkdownContent';
import { CodeViewer } from './CodeViewer';
import { JsxPreview } from './JsxPreview';
import type { MarkdownSelectionAction } from './useMarkdownSelectionAction';

export interface FileContentRendererProps {
  file: FileData;
  openFilePath: string | null;
  isMarkdown: boolean;
  isHtml: boolean;
  isJsx: boolean;
  markdownRendered: boolean;
  htmlPreview: boolean;
  jsxPreview: boolean;
  editMode: boolean;
  scrollToLine: number | null;
  worktreeId: string | null;
  currentWorktree?: WorktreeEntry;
  mdContainerRef: React.RefObject<HTMLDivElement>;
  mdSelectionAction: MarkdownSelectionAction | null;
  onMdAddToChat: (action: MarkdownSelectionAction, comment: string) => void;
  onSave: (c: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  rawUrl: (p: string) => string;
  revealInFinder: (path: string) => void;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
  listenSentences?: ListenSentence[];
  activeListenAnchor?: string;
  onListenSentenceStart?: (index: number) => void;
}

/** Renders file content: binary (image/audio/video), markdown, HTML, JSX, or code. */
export function FileContentRenderer({
  file,
  openFilePath,
  isMarkdown,
  isHtml,
  isJsx,
  markdownRendered,
  htmlPreview,
  jsxPreview,
  editMode,
  scrollToLine,
  worktreeId,
  currentWorktree,
  mdContainerRef,
  mdSelectionAction,
  onMdAddToChat,
  onSave,
  onDirtyChange,
  rawUrl,
  revealInFinder,
  restoreScrollTop,
  restoreKey,
  onScrollTopChange,
  listenSentences,
  activeListenAnchor,
  onListenSentenceStart,
}: FileContentRendererProps) {
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  onScrollTopChangeRef.current = onScrollTopChange;
  const restoreScrollTopRef = useRef(restoreScrollTop);
  restoreScrollTopRef.current = restoreScrollTop;

  const mdActive = isMarkdown && markdownRendered && !editMode;
  const [followListenPosition, setFollowListenPosition] = useState(true);

  const scrollToActiveSentence = useCallback(
    (behavior: ScrollBehavior) => {
      const container = mdContainerRef.current;
      if (!container || !activeListenAnchor) return;
      const sentence = [...container.querySelectorAll<HTMLElement>('[data-listen-sentence-anchor]')].find(
        (element) => element.dataset.listenSentenceAnchor === activeListenAnchor,
      );
      sentence?.scrollIntoView({ block: 'center', behavior });
    },
    [activeListenAnchor, mdContainerRef],
  );

  useEffect(() => {
    const container = mdContainerRef.current;
    if (!container || !mdActive || !activeListenAnchor) return;
    const pauseFollowing = () => setFollowListenPosition(false);
    container.addEventListener('wheel', pauseFollowing, { passive: true });
    container.addEventListener('touchstart', pauseFollowing, { passive: true });
    return () => {
      container.removeEventListener('wheel', pauseFollowing);
      container.removeEventListener('touchstart', pauseFollowing);
    };
  }, [activeListenAnchor, mdActive, mdContainerRef]);

  useEffect(() => {
    if (followListenPosition) scrollToActiveSentence('smooth');
  }, [followListenPosition, scrollToActiveSentence]);

  useEffect(() => {
    const el = mdContainerRef.current;
    if (!el || !mdActive || !onScrollTopChangeRef.current) return;
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        onScrollTopChangeRef.current?.(el.scrollTop);
      });
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (rafId) {
        cancelAnimationFrame(rafId);
        onScrollTopChangeRef.current?.(el.scrollTop);
      }
    };
  }, [mdContainerRef, onScrollTopChange, mdActive]);

  useEffect(() => {
    const el = mdContainerRef.current;
    if (!el || !mdActive || !onScrollTopChangeRef.current) return;
    const saved = restoreScrollTopRef.current;
    if (saved != null) {
      el.scrollTop = saved;
    } else {
      onScrollTopChangeRef.current(el.scrollTop);
    }
  }, [restoreKey, onScrollTopChange, mdActive, mdContainerRef]);
  if (file.binary) {
    if (file.mime.startsWith('image/'))
      return (
        <div className="flex-1 flex items-center justify-center bg-[var(--ws-editor-bg)] p-4 overflow-auto">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={rawUrl(file.path)} alt={file.path} className="max-w-full max-h-full object-contain rounded" />
        </div>
      );
    if (file.mime.startsWith('audio/'))
      return (
        <div className="flex-1 flex flex-col items-center justify-center bg-[var(--ws-editor-bg)] p-6 gap-3">
          <HubIcon name="music" className="h-8 w-8 text-cafe-secondary" />
          <audio controls src={rawUrl(file.path)} className="w-full max-w-md">
            浏览器不支持音频播放
          </audio>
          <p className="text-micro text-cafe-secondary">
            {file.mime} · {Math.round(file.size / 1024)}KB
          </p>
        </div>
      );
    if (file.mime.startsWith('video/'))
      return (
        <div className="flex-1 flex items-center justify-center bg-[var(--ws-editor-bg)] p-4 overflow-auto">
          <video controls src={rawUrl(file.path)} className="max-w-full max-h-full rounded">
            浏览器不支持视频播放
          </video>
        </div>
      );
    return (
      <div className="flex flex-col items-center justify-center py-8 bg-[var(--ws-editor-bg)] text-cafe-secondary text-xs">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-7 w-7 mb-2 text-cafe-muted"
        >
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
        </svg>
        <p>二进制文件</p>
        <p className="text-micro mt-1">
          {file.mime} · {Math.round(file.size / 1024)}KB
        </p>
        <button
          type="button"
          onClick={() => void revealInFinder(file.path)}
          className="mt-2 px-3 py-1 rounded bg-cafe-surface-sunken/20 text-cafe-interactive/60 hover:bg-cafe-surface-sunken/40 transition-colors text-micro"
        >
          在 Finder 中打开
        </button>
      </div>
    );
  }

  if (isMarkdown && markdownRendered && !editMode)
    return (
      <div className="relative flex-1 min-h-0">
        <div className="h-full overflow-auto bg-cafe-white p-4" ref={mdContainerRef}>
          <MarkdownContent
            content={maskLeadingMarkdownFrontmatter(file.content)}
            disableCommandPrefix
            basePath={openFilePath ? openFilePath.split('/').slice(0, -1).join('/') : undefined}
            worktreeId={worktreeId ?? undefined}
            listenSentences={listenSentences}
            activeListenAnchor={activeListenAnchor}
            onListenSentenceStart={onListenSentenceStart}
          />
        </div>
        {activeListenAnchor && !followListenPosition && (
          <button
            type="button"
            onClick={() => {
              setFollowListenPosition(true);
              scrollToActiveSentence('smooth');
            }}
            aria-label="回到当前句"
            title="跳回正在播放的句子"
            className="absolute bottom-3 right-8 z-20 rounded-full border border-cafe bg-cafe-surface/90 px-3 py-1.5 text-xs text-cafe-secondary shadow-sm transition-colors hover:border-cafe hover:bg-cafe-surface"
          >
            回到当前句
          </button>
        )}
        <LiveSelectionAnnotationAction
          action={mdSelectionAction}
          resetKey={openFilePath}
          positionMode="absolute"
          actionTestId="workspace-markdown-selection-add-to-chat"
          onSave={onMdAddToChat}
        />
      </div>
    );

  if (isHtml && htmlPreview && !editMode)
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-2 py-1 bg-[var(--semantic-warning-surface)] text-conn-amber-text text-micro border-b border-[var(--semantic-warning)] flex-shrink-0">
          预览模式 — 相对资源路径（图片/CSS/JS）可能无法加载
        </div>
        <div className="flex-1 min-h-0 bg-cafe-surface">
          <iframe
            srcDoc={file.content}
            sandbox="allow-scripts"
            title="HTML Preview"
            className="w-full h-full border-0"
          />
        </div>
      </div>
    );

  if (isJsx && jsxPreview && !editMode)
    return <JsxPreview code={file.content} filePath={openFilePath!} worktreeId={worktreeId} />;

  return (
    <CodeViewer
      content={file.content}
      mime={file.mime}
      path={file.path}
      scrollToLine={scrollToLine}
      editable={editMode}
      onSave={onSave}
      onDirtyChange={onDirtyChange}
      branch={currentWorktree?.branch}
      worktreeId={worktreeId}
      restoreScrollTop={restoreScrollTop}
      restoreKey={restoreKey}
      onScrollTopChange={onScrollTopChange}
    />
  );
}
