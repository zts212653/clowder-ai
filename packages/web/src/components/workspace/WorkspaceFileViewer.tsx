'use client';

import { useCallback, useRef } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { createQuoteContextAttachment } from '../chat-context-reference';
import { FileContentRenderer } from './FileContentRenderer';
import { FileIcon } from './FileIcons';
import { type MarkdownSelectionAction, useMarkdownSelectionAction } from './useMarkdownSelectionAction';
import { useWorkspaceListenMode } from './useWorkspaceListenMode';
import { WorkspaceToolbarButton as ToolbarBtn } from './WorkspaceToolbarButton';

interface WorkspaceFileViewerProps {
  file: FileData;
  openFilePath: string | null;
  openTabs: string[];
  canEdit: boolean;
  editMode: boolean;
  isMarkdown: boolean;
  isHtml: boolean;
  isJsx: boolean;
  markdownRendered: boolean;
  htmlPreview: boolean;
  jsxPreview: boolean;
  saveError: string | null;
  scrollToLine: number | null;
  worktreeId: string | null;
  currentWorktree?: WorktreeEntry;
  setOpenFile: (path: string) => void;
  closeTab: (path: string) => void;
  onCloseCurrentTab: () => void;
  onToggleEdit: () => void;
  onToggleMarkdownRendered: () => void;
  onToggleHtmlPreview: () => void;
  onToggleJsxPreview: () => void;
  onSave: (content: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  pendingExternalSha?: string | null;
  onApplyExternalChange?: () => void;
  onDismissExternalChange?: () => void;
  revealInFinder: (path: string) => void;
  onFocusMode?: () => void;
  focusDisabled?: boolean;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
}

const CloseIcon = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path d="M1 1l8 8M9 1l-8 8" />
  </svg>
);

const PlayIcon = () => (
  <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 12 14" fill="currentColor">
    <path d="M1 1l10 6-10 6V1z" />
  </svg>
);

export function WorkspaceFileViewer({
  file,
  openFilePath,
  openTabs,
  canEdit,
  editMode,
  isMarkdown,
  isHtml,
  isJsx,
  markdownRendered,
  htmlPreview,
  jsxPreview,
  saveError,
  scrollToLine,
  worktreeId,
  currentWorktree,
  setOpenFile,
  closeTab,
  onCloseCurrentTab,
  onToggleEdit,
  onToggleMarkdownRendered,
  onToggleHtmlPreview,
  onToggleJsxPreview,
  onSave,
  onDirtyChange,
  pendingExternalSha,
  onApplyExternalChange,
  onDismissExternalChange,
  revealInFinder,
  onFocusMode,
  focusDisabled,
  restoreScrollTop,
  restoreKey,
  onScrollTopChange,
}: WorkspaceFileViewerProps) {
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const mdSelectionAction = useMarkdownSelectionAction(
    mdContainerRef,
    isMarkdown && markdownRendered && !editMode,
    openFilePath,
  );

  const handleMdAddToChat = useCallback(
    (action: MarkdownSelectionAction, comment: string) => {
      if (!openFilePath) return;
      setPendingChatInsert({
        threadId: currentThreadId,
        text: '',
        contextAttachments: [
          createQuoteContextAttachment(
            action.text,
            {
              kind: 'workspace_file',
              path: openFilePath,
              ...(worktreeId ? { worktreeId } : {}),
              ...(currentWorktree?.branch ? { branch: currentWorktree.branch } : {}),
              language: 'markdown',
            },
            {
              comment,
              ...(action.selectionStart !== undefined && action.selectionEnd !== undefined
                ? {
                    selectionStart: action.selectionStart,
                    selectionEnd: action.selectionEnd,
                  }
                : {}),
            },
          ),
        ],
      });
    },
    [currentThreadId, currentWorktree, openFilePath, setPendingChatInsert, worktreeId],
  );

  const rawUrl = (path: string) =>
    `${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(path)}`;
  const listenMode = useWorkspaceListenMode({
    file,
    openFilePath,
    worktreeId,
    enabled: isMarkdown && markdownRendered && !editMode && !file.truncated,
  });

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col animate-fade-in" data-testid="workspace-file-viewer">
      {/* Tab bar */}
      {openTabs.length > 0 && (
        <div className="flex bg-[var(--ws-editor-bg)] border-b border-[var(--ws-editor-surface)] overflow-x-auto scrollbar-none">
          {openTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setOpenFile(tab)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border-r border-[var(--ws-editor-surface)] flex-shrink-0 transition-colors ${
                tab === openFilePath
                  ? 'bg-[var(--ws-editor-surface)] text-cafe-muted'
                  : 'text-cafe-secondary hover:text-cafe-muted hover:bg-[var(--ws-editor-hover)]'
              }`}
              title={tab}
            >
              <FileIcon name={tab} />
              <span className="truncate max-w-[120px]">{tab.split('/').pop()}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    closeTab(tab);
                  }
                }}
                className="ml-0.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-cafe-surface/10 transition-opacity text-cafe-secondary hover:text-cafe-muted"
                title="关闭"
                aria-label={`关闭 ${tab.split('/').pop() ?? tab}`}
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div
        data-testid="workspace-file-toolbar"
        className="w-full min-w-0 overflow-x-auto overscroll-x-contain bg-[var(--ws-editor-bg)] px-3 py-1"
        role="toolbar"
        aria-label="文件操作工具栏，可横向滚动"
      >
        <div
          data-testid="workspace-file-toolbar-content"
          className="flex w-max min-w-full items-center justify-between gap-3"
        >
          <div className="flex shrink-0 items-center gap-2">
            {file.size > 0 && (
              <span className="text-micro text-cafe-secondary font-mono flex-shrink-0">
                {file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isMarkdown && !editMode && (
              <ToolbarBtn
                active={markdownRendered}
                onClick={onToggleMarkdownRendered}
                title={markdownRendered ? '\u5207\u6362\u5230\u6E90\u7801' : '\u5207\u6362\u5230\u6E32\u67D3'}
              >
                {markdownRendered ? 'Rendered' : 'Raw'}
              </ToolbarBtn>
            )}
            {isMarkdown && markdownRendered && !editMode && (
              <ToolbarBtn
                active={listenMode.active}
                activeClass="bg-cafe-accent text-[var(--cafe-accent-foreground)] hover:bg-cafe-interactive"
                onClick={() => listenMode.start()}
                title={listenMode.sentences.length > 0 ? '从上次位置开始听读' : '这份 Markdown 没有可听正文'}
                disabled={listenMode.sentences.length === 0}
              >
                <span className="inline-flex items-center gap-1">
                  <PlayIcon />
                  听读
                </span>
              </ToolbarBtn>
            )}
            {isHtml && !editMode && (
              <ToolbarBtn
                active={htmlPreview}
                onClick={onToggleHtmlPreview}
                title={htmlPreview ? '\u5207\u6362\u5230\u6E90\u7801' : '\u9884\u89C8 HTML'}
              >
                {htmlPreview ? 'Preview' : 'Code'}
              </ToolbarBtn>
            )}
            {isJsx && !editMode && (
              <ToolbarBtn
                active={jsxPreview}
                onClick={onToggleJsxPreview}
                title={jsxPreview ? '\u5207\u6362\u5230\u6E90\u7801' : '\u9884\u89C8 JSX/TSX'}
                activeClass="bg-blue-600/80 text-[var(--cafe-surface)] hover:bg-conn-blue-text"
              >
                {jsxPreview ? 'Preview' : 'Code'}
              </ToolbarBtn>
            )}
            {file.content != null && (
              <ToolbarBtn
                onClick={() => void navigator.clipboard.writeText(file.content)}
                title={
                  file.truncated ? '\u590D\u5236\u5DF2\u52A0\u8F7D\u5185\u5BB9' : '\u590D\u5236\u6587\u4EF6\u5168\u6587'
                }
              >
                {file.truncated ? 'Copy\u2026' : 'Copy'}
              </ToolbarBtn>
            )}
            <ToolbarBtn
              onClick={() => {
                if (!openFilePath) return;
                const abs = currentWorktree ? `${currentWorktree.root}/${openFilePath}` : openFilePath;
                void navigator.clipboard.writeText(abs);
              }}
              title="\u590D\u5236\u7EDD\u5BF9\u8DEF\u5F84"
            >
              Path
            </ToolbarBtn>
            <ToolbarBtn
              onClick={() => {
                if (openFilePath) void revealInFinder(openFilePath);
              }}
              title="\u5728 Finder \u4E2D\u663E\u793A"
            >
              Finder
            </ToolbarBtn>
            {canEdit && (
              <ToolbarBtn
                active={editMode}
                onClick={onToggleEdit}
                title={editMode ? '\u9000\u51FA\u7F16\u8F91' : '\u7F16\u8F91\u6587\u4EF6'}
                activeClass="bg-green-600/80 text-[var(--cafe-surface)] hover:bg-conn-green-text"
              >
                {editMode ? '\u7F16\u8F91\u4E2D' : '\u7F16\u8F91'}
              </ToolbarBtn>
            )}
            {onFocusMode && (
              <ToolbarBtn onClick={onFocusMode} title="\u4E13\u6CE8\u6A21\u5F0F" disabled={focusDisabled}>
                专注
              </ToolbarBtn>
            )}
            <button
              type="button"
              onClick={onCloseCurrentTab}
              className="w-5 h-5 flex items-center justify-center rounded text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10 transition-colors"
              title="关闭标签页"
              aria-label="关闭标签页"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="px-3 py-1.5 text-micro text-conn-red-text bg-[var(--semantic-critical-surface)] border-b border-[var(--semantic-critical)]">
          {saveError}
        </div>
      )}

      {pendingExternalSha && (
        <div className="px-3 py-1.5 text-micro text-conn-amber-text bg-[var(--semantic-warning-surface)] border-b border-[var(--semantic-warning)] flex items-center justify-between">
          <span>文件已被外部修改</span>
          <span className="flex gap-2">
            <button type="button" onClick={onApplyExternalChange} className="underline hover:text-conn-amber-text">
              重新加载
            </button>
            <button type="button" onClick={onDismissExternalChange} className="underline hover:text-conn-amber-text">
              忽略
            </button>
          </span>
        </div>
      )}

      {/* File content */}
      <FileContentRenderer
        file={file}
        openFilePath={openFilePath}
        isMarkdown={isMarkdown}
        isHtml={isHtml}
        isJsx={isJsx}
        markdownRendered={markdownRendered}
        htmlPreview={htmlPreview}
        jsxPreview={jsxPreview}
        editMode={editMode}
        scrollToLine={scrollToLine}
        worktreeId={worktreeId}
        currentWorktree={currentWorktree}
        mdContainerRef={mdContainerRef}
        mdSelectionAction={mdSelectionAction}
        onMdAddToChat={handleMdAddToChat}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        rawUrl={rawUrl}
        revealInFinder={revealInFinder}
        restoreScrollTop={restoreScrollTop}
        restoreKey={restoreKey}
        onScrollTopChange={onScrollTopChange}
        listenSentences={listenMode.active ? listenMode.sentences : undefined}
        activeListenAnchor={listenMode.activeAnchor}
        onListenSentenceStart={listenMode.active ? listenMode.start : undefined}
      />

      {file.truncated && (
        <div className="px-3 py-1.5 text-micro text-conn-amber-text bg-[var(--ws-editor-bg)] border-t border-[var(--semantic-warning)]">
          文件已截断 (超过 1MB)
        </div>
      )}
    </div>
  );
}
