'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { FileContentRenderer } from './FileContentRenderer';
import { FileIcon } from './FileIcons';

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
  revealInFinder: (path: string) => void;
  onFocusMode?: () => void;
  focusDisabled?: boolean;
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
  revealInFinder,
  onFocusMode,
  focusDisabled,
}: WorkspaceFileViewerProps) {
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const [mdHasSelection, setMdHasSelection] = useState(false);
  const mdContainerRef = useRef<HTMLDivElement>(null);

  // Markdown selection detection for "Add to Chat"
  useEffect(() => {
    const container = mdContainerRef.current;
    if (!container) {
      setMdHasSelection(false);
      return;
    }
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) {
        setMdHasSelection(false);
        return;
      }
      setMdHasSelection(!!sel.toString().trim());
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [markdownRendered, openFilePath, editMode]);

  const handleMdAddToChat = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const container = mdContainerRef.current;
    if (!container || !container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    const text = sel.toString().trim();
    if (!text || !openFilePath) return;
    const branch = currentWorktree?.branch;
    const suffix = branch ? ` (\u{1F33F} ${branch})` : '';
    setPendingChatInsert({
      threadId: currentThreadId,
      text: `\`${openFilePath}\`${suffix}\n\`\`\`markdown\n${text}\n\`\`\``,
    });
  }, [currentThreadId, currentWorktree, openFilePath, setPendingChatInsert]);

  const rawUrl = (path: string) =>
    `${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(path)}`;

  return (
    <div className="flex-1 flex flex-col min-h-0 animate-fade-in">
      {/* Tab bar */}
      {openTabs.length > 0 && (
        <div className="flex bg-[#1E1E24] border-b border-[#2a2a32] overflow-x-auto scrollbar-none">
          {openTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setOpenFile(tab)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono border-r border-[#2a2a32] flex-shrink-0 transition-colors ${
                tab === openFilePath
                  ? 'bg-[#2a2a32] text-gray-200'
                  : 'text-cafe-secondary hover:text-cafe-muted hover:bg-[#252530]'
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
                title="\u5173\u95ED"
              >
                \u00D7
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="px-3 py-1 bg-[#1E1E24] flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {file.size > 0 && (
            <span className="text-[9px] text-cafe-secondary font-mono flex-shrink-0">
              {file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isMarkdown && !editMode && (
            <ToolbarBtn
              active={markdownRendered}
              onClick={onToggleMarkdownRendered}
              title={markdownRendered ? '\u5207\u6362\u5230\u6E90\u7801' : '\u5207\u6362\u5230\u6E32\u67D3'}
            >
              {markdownRendered ? 'Rendered' : 'Raw'}
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
              activeClass="bg-blue-600/80 text-white hover:bg-blue-500"
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
              activeClass="bg-green-600/80 text-white hover:bg-green-500"
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
            title="\u5173\u95ED\u6807\u7B7E\u9875"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {saveError && (
        <div className="px-3 py-1.5 text-[10px] text-red-400 bg-red-900/20 border-b border-red-900/30">{saveError}</div>
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
        mdHasSelection={mdHasSelection}
        onMdAddToChat={handleMdAddToChat}
        onSave={onSave}
        rawUrl={rawUrl}
        revealInFinder={revealInFinder}
      />

      {file.truncated && (
        <div className="px-3 py-1.5 text-[10px] text-amber-400 bg-[#1E1E24] border-t border-amber-900/30">
          \u6587\u4EF6\u5DF2\u622A\u65AD (超过 1MB)
        </div>
      )}
    </div>
  );
}

/* ── Toolbar button helper ── */
function ToolbarBtn({
  children,
  active,
  activeClass,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  const ac = activeClass ?? 'bg-cocreator-primary/80 text-white hover:bg-cocreator-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${active ? ac : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'} ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
      title={title}
    >
      {children}
    </button>
  );
}
