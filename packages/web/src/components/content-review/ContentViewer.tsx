'use client';

import { fileContentKind, type MessageQuoteSource, type QuoteContextSource } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import { type ListenSentence, maskLeadingMarkdownFrontmatter } from '@/lib/listen-mode/markdown-sentences';
import { LISTEN_RETURN_DOCUMENT_EVENT } from '@/stores/listenModeStore';
import { chatReferenceCopy } from '../chat-references/chat-reference.shell-copy';
import { LiveSelectionAnnotationAction } from '../LiveSelectionAnnotationAction';
import { MarkdownContent } from '../MarkdownContent';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { WorkspaceFileQuoteMarks } from '../workbench/content-review/WorkspaceFileQuoteMarks';
import { WorkspacePendingFileQuoteMarks } from '../workbench/content-review/WorkspacePendingFileQuoteMarks';
import { useWorkspaceSurfaceVisibility } from '../workbench/WorkspaceSurfaceVisibility';
import { CodeViewer } from '../workspace/CodeViewer';
import { JsxPreview } from '../workspace/JsxPreview';
import { OfficeFileCard } from '../workspace/OfficeFileCard';
import type { MarkdownSelectionAction } from '../workspace/useMarkdownSelectionAction';
import { WorkspaceHtmlPreview } from '../workspace/WorkspaceHtmlPreview';
import type { WorkspaceFileSave } from '../workspace/workspace-file-draft';
import { ArtworkPreviewMedia } from './ArtworkPreviewMedia';
import { fileByteLengthLabel } from './artwork-file-labels';
import { ContentMediaElement } from './ContentMediaElement';

function scrollMarkdownToSourceLine(container: HTMLDivElement | null, isActive: boolean, line: number | null): void {
  if (!container || !isActive || !line || line < 1) return;

  const exactTarget = container.querySelector<HTMLElement>(`[data-workspace-link-line="${line}"]`);
  const sourceLines = [...container.querySelectorAll<HTMLElement>('[data-source-line]')];
  const target =
    exactTarget ?? sourceLines.filter((node) => Number(node.dataset.sourceLine) <= line).at(-1) ?? sourceLines[0];
  target?.scrollIntoView({ block: 'center', behavior: 'auto' });
}

export interface ContentViewerProps {
  file: FileData;
  sourceKey?: string;
  listenCacheKey?: string;
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
  onMdAddToChat: (action: MarkdownSelectionAction, comment: string) => void | boolean;
  collectMdComment?: boolean;
  mdQuoteLabel?: string;
  onSave?: WorkspaceFileSave;
  onDirtyChange?: (dirty: boolean) => void;
  rawUrl: (p: string) => string;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
  listenSentences?: ListenSentence[];
  activeListenAnchor?: string;
  onListenSentenceStart?: (index: number) => void;
  showFileQuotes?: boolean;
  onQuoteSelected?: (quote: string) => void;
  /** Explicit published leaf; false keeps a preview with unverifiable origin from inventing a workspace quote. */
  quoteSource?: QuoteContextSource | false;
  publishedQuoteSource?: MessageQuoteSource;
}

/** Renders file content: binary (image/audio/video), markdown, HTML, JSX, or code. */
export function ContentViewer({
  file,
  sourceKey,
  listenCacheKey,
  openFilePath,

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
  collectMdComment,
  mdQuoteLabel,
  onSave,
  onDirtyChange,
  rawUrl,
  restoreScrollTop,
  restoreKey,
  onScrollTopChange,
  listenSentences,
  activeListenAnchor,
  onListenSentenceStart,
  showFileQuotes,
  onQuoteSelected,
  quoteSource,
  publishedQuoteSource,
}: ContentViewerProps) {
  const contentKind = fileContentKind(file.path, file.mime);
  const isMarkdown = contentKind === 'markdown',
    isHtml = contentKind === 'html',
    isJsx = contentKind === 'jsx';
  const visible = useWorkspaceSurfaceVisibility();
  const isV2 = useShellPresentation() === 'v2';
  const t = useShellCopy(chatReferenceCopy);
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
    const reveal = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (
        detail &&
        typeof detail === 'object' &&
        'worktreeId' in detail &&
        detail.worktreeId === worktreeId &&
        'cacheKey' in detail &&
        activeListenAnchor &&
        (detail.cacheKey === listenCacheKey || !listenCacheKey)
      ) {
        setFollowListenPosition(true);
        scrollToActiveSentence('smooth');
      }
    };
    window.addEventListener(LISTEN_RETURN_DOCUMENT_EVENT, reveal);
    return () => window.removeEventListener(LISTEN_RETURN_DOCUMENT_EVENT, reveal);
  }, [activeListenAnchor, listenCacheKey, worktreeId, scrollToActiveSentence]);

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

  useEffect(() => {
    scrollMarkdownToSourceLine(mdContainerRef.current, mdActive, scrollToLine);
  }, [mdActive, mdContainerRef, scrollToLine]);

  // The byte reader knows whether an otherwise unknown format contains text.
  if (file.binary || ['image', 'video', 'audio', 'office'].includes(contentKind)) {
    if (/\.(?:pptx?|docx?|xlsx?)$/i.test(file.path)) return <OfficeFileCard file={file} />;
    const kind = fileContentKind(file.path, file.mime);
    if (kind === 'image' || kind === 'video')
      return <ArtworkPreviewMedia url={rawUrl(file.path)} title={file.path} video={kind === 'video'} />;
    if (kind === 'audio')
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <ContentMediaElement kind="audio" src={rawUrl(file.path)} className="w-full max-w-md" />
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
          {file.mime} · {fileByteLengthLabel(file.size) ?? t.sizeUnknown}
        </p>
      </div>
    );
  }

  if (isMarkdown && markdownRendered && !editMode)
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {showFileQuotes && worktreeId && openFilePath && (
          <>
            <WorkspaceFileQuoteMarks
              locator={{ worktreeId, path: openFilePath }}
              revision={`sha256:${file.sha256.replace(/^sha256:/, '')}`}
              text={file.content}
              container={mdContainerRef}
              visible={visible}
            />
            <WorkspacePendingFileQuoteMarks
              locator={{ worktreeId, path: openFilePath }}
              revision={`sha256:${file.sha256.replace(/^sha256:/, '')}`}
              text={file.content}
              container={mdContainerRef}
              visible={visible}
            />
          </>
        )}
        {publishedQuoteSource?.artifactFile && (
          <WorkspacePendingFileQuoteMarks
            publishedSource={publishedQuoteSource}
            revision={publishedQuoteSource.artifactFile.displayDigest}
            text={file.content}
            container={mdContainerRef}
            visible={visible}
          />
        )}
        <div
          className={`min-h-0 flex-1 overflow-auto bg-cafe-white p-4 ${showFileQuotes || publishedQuoteSource ? 'pl-10 pr-16' : ''}`}
          ref={mdContainerRef}
          data-testid={showFileQuotes ? 'workspace-content-review-text' : undefined}
          onMouseUp={() => onQuoteSelected?.(window.getSelection()?.toString().trim() ?? '')}
        >
          <MarkdownContent
            content={maskLeadingMarkdownFrontmatter(file.content)}
            disableCommandPrefix
            basePath={
              quoteSource === undefined && openFilePath ? openFilePath.split('/').slice(0, -1).join('/') : undefined
            }
            sourcePath={quoteSource === undefined ? (openFilePath ?? undefined) : undefined}
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
          resetKey={sourceKey ?? openFilePath}
          positionMode="absolute"
          actionTestId={
            showFileQuotes ? 'workspace-content-review-text-add-to-chat' : 'workspace-markdown-selection-add-to-chat'
          }
          onSave={onMdAddToChat}
          collectComment={collectMdComment}
          triggerContent={mdQuoteLabel}
        />
      </div>
    );

  if (isV2 && isHtml && htmlPreview && !editMode && worktreeId)
    return <WorkspaceHtmlPreview worktreeId={worktreeId} path={file.path} content={file.content} />;

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
      baseSha256={file.sha256}
      restoreScrollTop={restoreScrollTop}
      restoreKey={restoreKey}
      onScrollTopChange={onScrollTopChange}
      quoteSource={quoteSource}
    />
  );
}
